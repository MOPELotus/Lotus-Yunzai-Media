import { fileURLToPath } from "node:url"
import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import type { BotNotifications } from "../../../../lib/checkin-notify.ts"
import type { MessageReply } from "../../../../lib/messages.ts"
import { biliSubscriptionLogin } from "./bilibili/login.ts"
import { createBiliProvider } from "./bilibili/index.ts"
import { biliSharedSession } from "./bilibili/shared.ts"
import { weiboSubscriptionLogin } from "./weibo/login.ts"
import { createWeiboProvider } from "./weibo/index.ts"
import { createWeiboPreview } from "./weibo/preview.ts"
import { createSubscriptionConfig, numericId, type SubscriptionRoute, type SubscriptionDestination } from "./config.ts"
import { createSubscriptionDelivery, type SubscriptionGroups } from "./delivery.ts"
import { profileText } from "./profile.ts"
import { subscriptionSession } from "./session.ts"
import { renderSubscriptionHelp } from "./help.ts"
import { createAuthorVideoModule } from "./xhh-author-command.ts"
import type { makeDynamicMessages } from "./render.ts"
import type {
  GetSubscriptionRedis, LockSubscriptionFile, SubscriptionContext, SubscriptionPlatform, SubscriptionProvider,
  SubscriptionProviders, SubscriptionRedis,
} from "./types.ts"

interface SubscriptionServices {
  readonly lockFile: LockSubscriptionFile
  readonly groups?: SubscriptionGroups
  readonly signal?: AbortSignal
  readonly subscriptionTransport?: () => readonly BotNotifications[]
  readonly mediaRuntime?: { whenReady(start: () => void): () => void }
  readonly quotedBilibiliAuthor?: (context: MessageFallbackContext) => Promise<string | undefined>
}

interface SubscriptionOptions {
  providers?: SubscriptionProviders
  directory?: string
  shared?: ReturnType<typeof biliSharedSession>
  getRedis?: GetSubscriptionRedis
  render?: typeof makeDynamicMessages
  now?: () => number
  renderHelp?: () => Promise<MessageReply>
  fetchWeiboPost?: Parameters<typeof createWeiboPreview>[0]["fetchPost"]
  fetchWeiboComments?: Parameters<typeof createWeiboPreview>[0]["fetchComments"]
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

const dataDirectory = fileURLToPath(new URL("../../../../data",import.meta.url))
const prefix = /^[#/]/u
const help = /^[#/]媒体帮助$/u
const platformName = "(哔哩哔哩|哔哩|bilibili|bili|b站|微博|weibo)"
const edit = new RegExp("^(订阅|添加|add|取消|删除|del)"+platformName+"推送\\s*(.*)$","iu")
const list = new RegExp("^"+platformName+"(全部)?(?:推送|动态|订阅)列表$","iu")
const manual = new RegExp("^执行"+platformName+"任务$","iu")
const profile = new RegExp("^"+platformName+"(?:up|up主|博主|bo主)(uid|昵称)\\s*[:：]?\\s*(.*)$","iu")
const categories = /^(视频|图文|文章|转发|直播)\s*/u

function platform(value: string): SubscriptionPlatform {
  return /^(微博|weibo)$/iu.test(value) ? "weibo" : "bilibili"
}

function target(context: SubscriptionContext): SubscriptionDestination | undefined {
  const kind = context.message_type
  if (kind !== "group" && kind !== "private") return
  const chat = numericId(kind === "group" ? context.group_id : context.user_id)
  const bot = numericId(context.self_id)
  if (chat && bot) return { kind,chat,bot }
}

function isSubscriptionOwner(context: SubscriptionContext) {
  if (context.adapter !== "milky") return context.isMaster === true
  const user = context.user_id
  return context.isDelegated !== true && typeof user === "number" && Number.isSafeInteger(user) && user > 0 && context.isBotMaster?.(user) === true
}

function editArguments(input: string,provider: SubscriptionProvider) {
  const selected = new Set<string>()
  let rest = input.trim()
  for (let match; (match=categories.exec(rest));) {
    for (const [code,label] of Object.entries(provider.typeNames)) if (label === match[1]) selected.add(code)
    if (!match[1] || !Object.values(provider.typeNames).includes(match[1])) return
    rest = rest.slice(match[0].length)
  }
  rest = rest.replace(/^(?:uid\s*)?[:：]?\s*/iu,"")
  const uid = numericId(rest)
  if (uid) return {uid,selected:[...selected]}
}

function display(provider: SubscriptionProvider, items: readonly SubscriptionRoute[], heading: string) {
  if (!items.length) return heading+"\n当前没有订阅。"
  return heading+"\n"+items.map(item=>{
    const types = [...new Set(item.types.map(type=>provider.typeNames[type]).filter(Boolean))]
    return item.uid+"："+item.name+" ["+(types.length?types.join("、"):"全部动态")+"]"
  }).join("\n")
}

export async function createSubscriptionModule(services: SubscriptionServices, { providers, directory=dataDirectory, shared,
  getRedis=()=>(globalThis as { redis?: SubscriptionRedis }).redis, render, now,
  renderHelp=renderSubscriptionHelp, fetchWeiboPost, fetchWeiboComments }: SubscriptionOptions = {}) {
  const weiboSession = subscriptionSession("weibo", directory, getRedis)
  const config = createSubscriptionConfig(directory,services.lockFile)
  shared ??= biliSharedSession({ enabled: async () => (await config.settings("bilibili")).sharedBiliLogin })
  const sources = providers ?? {
    bilibili: createBiliProvider({ session: subscriptionSession("bilibili", directory, getRedis), shared }),
    weibo: createWeiboProvider({ session: weiboSession }),
  }
  const biliLogin = biliSubscriptionLogin({ getRedis, owner: isSubscriptionOwner, signal: services.signal,
    directory, lockFile: services.lockFile, shared,
    setShared: (enabled: boolean, signal?: AbortSignal) => config.editSettings("bilibili", () => ({ sharedBiliLogin: enabled }), signal) })
  const weiboLogin = weiboSubscriptionLogin({ getRedis, session: weiboSession, owner: isSubscriptionOwner, signal: services.signal })
  const weiboPreview = createWeiboPreview({ settings: () => config.settings("weibo"), signal: services.signal,
    fetchPost: fetchWeiboPost, fetchComments: fetchWeiboComments, render })
  const dispatch = createSubscriptionDelivery({ providers:sources,config,groups:services.groups,notifications:services.subscriptionTransport,
    getRedis,signal:services.signal,render,now })
  const authorVideos = sources.bilibili && createAuthorVideoModule({
    directory, lockFile: services.lockFile, provider: sources.bilibili,
    settings: () => config.settings("bilibili"), quotedAuthor: services.quotedBilibiliAuthor,
    groups: services.groups, notifications: services.subscriptionTransport, getRedis, signal: services.signal, render, now,
  })
  let startup: Promise<void> | undefined
  const cancelReady = services.mediaRuntime?.whenReady(() => {
    startup ??= Promise.all([dispatch.start(), authorVideos?.start()]).then(() => undefined)
      .catch(error => console.warn("[media] 订阅 · 启动定时任务失败：" + errorText(error)))
  })
  const describe = (provider: SubscriptionProvider) => provider.label + "订阅"

  const fallback: MessageFallback = async (message,context) => {
    if (help.test(message.trim())) return renderHelp()
    const author = await authorVideos?.fallback(message, context)
    if (author !== undefined) return author
    const weibo = await weiboPreview.fallback(message, context)
    if (weibo !== undefined) return weibo
    if (!prefix.test(message)) return
    const command=message.replace(prefix,"").trim()
    const match=edit.exec(command)
    const view=list.exec(command)
    const run=manual.exec(command)
    const lookup=profile.exec(command)
    const selected=match?.[2]||view?.[1]||run?.[1]||lookup?.[1]
    if (!selected) return (await biliLogin(message, context)) ?? weiboLogin(message, context)
    const provider=sources[platform(selected)]
    if (!provider) return
    const current=target(context)
    try {
      if (match) {
        if (!isSubscriptionOwner(context)) return "只有机器人主人可以修改"+describe(provider)+"。"
        if (!current) return "请在订阅要发送的群聊或私聊中设置。"
        const args=editArguments(match[3] ?? "",provider)
        if (!args) return "请在指令末尾填写有效的纯数字 UID。"
        const operation=/^(删除|取消|del)$/iu.test(match[1] ?? "")?"remove":"add"
        let name=args.uid
        let verificationFailure: string | undefined
        if (operation === "add" && !(await config.routes(provider.id)).some(item=>
          item.uid === args.uid && item.bot === current.bot && item.chat === current.chat && item.kind === current.kind)) {
          try {
            const info=await provider.profile(args.uid,{signal:services.signal,allowUnverified:true})
            if (!info) return "未找到 UID "+args.uid+" 的公开资料。"
            name=info.name
            verificationFailure=info.verificationFailure
          } catch (error) {
            return provider.label+"用户校验失败："+errorText(error)
          }
        }
        const updated=await config.update(provider.id,current,args.uid,operation,args.selected,Object.keys(provider.typeNames),name)
        if (updated && verificationFailure) {
          return "已更新"+describe(provider)+"\n"+args.uid+" 尚未校验（"+verificationFailure+"），已按 UID 保存，请确认 UID 正确。"
        }
        return updated ? "已更新"+describe(provider)+"\n"+updated.name+"："+args.uid : "当前会话没有订阅该 UID。"
      }
      if (view) {
        if (view[2] && !isSubscriptionOwner(context)) return "只有机器人主人可以查看全部"+describe(provider)+"。"
        if (!current && (!view[2] || context.message_type !== "terminal")) return "请在群聊或私聊中查询当前会话。"
        const all=await config.routes(provider.id)
        if (!view[2] && current) return display(provider,all.filter(item=>item.kind===current.kind && item.chat===current.chat && item.bot===current.bot),describe(provider))
        const blocks=new Map<string, SubscriptionRoute[]>()
        for (const item of all) {
          if (current && item.bot !== current.bot) continue
          const name=(item.kind==="group"?"群 ":"私聊 ")+item.chat+" · 机器人 "+item.bot
          let rows=blocks.get(name)
          if (!rows) { rows=[]; blocks.set(name,rows) }
          rows.push(item)
        }
        return blocks.size ? {type:"forward",nodes:[...blocks].map(([name,rows])=>display(provider,rows,name))} : describe(provider)+"当前没有订阅。"
      }
      if (run) {
        if (!isSubscriptionOwner(context)) return "只有机器人主人可以执行"+describe(provider)+"任务。"
        if (!getRedis()) return "订阅存储未连接。"
        const task=dispatch.run(provider.id)
        if (!task) return "订阅任务正在执行或已停止。"
        const record=await task
        return "已确认 "+record.confirmed+" 条，未发出 "+record.rejected+" 条，结果未确认 "+record.unknown+
          " 条，跳过 "+record.skipped+" 条，异常 "+record.failed+" 次。"
      }
      const mode = lookup?.[2]?.toLowerCase()
      const query = lookup?.[3] ?? ""
      const value = mode === "uid" ? numericId(query) : query.trim()
      if (!value) return "请输入要查询的 UID 或昵称。"
      const found=mode==="uid" ? [await provider.profile(value,{signal:services.signal})] :
        await provider.search?.(value,{signal:services.signal}) ?? []
      const rows=found.filter(value => value !== undefined).slice(0,8).map(profileText)
      return rows.length ? [{type:"text",text:rows.join("\n\n")}] : "没有找到公开用户资料。"
    } catch (error) {
      return describe(provider)+"处理失败："+errorText(error)
    }
  }
  return {
    commands:{}, fallback,
    features: (context: MessageFallbackContext) => [...(authorVideos?.features(context) ?? []), ...weiboPreview.features(context)],
    async dispose() {
      cancelReady?.()
      await Promise.all([dispatch.dispose(), authorVideos?.dispose()])
      await startup
    },
  }
}
