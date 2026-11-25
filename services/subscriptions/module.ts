import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
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
  const commandTypes = provider.commandTypeNames ?? provider.typeNames
  for (let match; (match=categories.exec(rest));) {
    for (const [code,label] of Object.entries(commandTypes)) if (label === match[1]) selected.add(code)
    if (!match[1] || !Object.values(commandTypes).includes(match[1])) return
    rest = rest.slice(match[0].length)
  }
  rest = rest.replace(/^(?:uid\s*)?[:：]?\s*/iu,"")
  const uid = numericId(rest)
  if (uid) return {uid,selected:[...selected]}
}

function display(provider: SubscriptionProvider, items: readonly SubscriptionRoute[], heading: string) {
  if (!items.length) return heading+$t("services.subscriptions.module.text_52160b7865")
  return heading+"\n"+items.map(item=>{
    const types = [...new Set(item.types.map(type=>provider.typeNames[type]).filter(Boolean))]
    return item.uid+"："+item.name+" ["+(types.length?types.join("、"):$t("services.subscriptions.module.text_e6b234fbec"))+"]"
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
      .catch(error => console.warn($t("services.subscriptions.module.text_2b72d177db") + errorText(error)))
  })
  const describe = (provider: SubscriptionProvider) => provider.label + $t("services.subscriptions.module.text_cf8efc450f")

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
        if (!isSubscriptionOwner(context)) return $t("services.subscriptions.module.text_2db3898cf0")+describe(provider)+"。"
        if (!current) return $t("services.subscriptions.module.text_7df1e748c3")
        const args=editArguments(match[3] ?? "",provider)
        if (!args) return $t("services.subscriptions.module.text_e17cfe63b4")
        const operation=/^(删除|取消|del)$/iu.test(match[1] ?? "")?"remove":"add"
        let name=args.uid
        let verificationFailure: string | undefined
        if (operation === "add" && !(await config.routes(provider.id)).some(item=>
          item.uid === args.uid && item.bot === current.bot && item.chat === current.chat && item.kind === current.kind)) {
          try {
            const info=await provider.profile(args.uid,{signal:services.signal,allowUnverified:true})
            if (!info) return $t("services.subscriptions.module.text_817b3d2c71")+args.uid+$t("services.subscriptions.module.text_402fe6da67")
            name=info.name
            verificationFailure=info.verificationFailure
          } catch (error) {
            return provider.label+$t("services.subscriptions.module.text_35d32344d7")+errorText(error)
          }
        }
        const updated=await config.update(provider.id,current,args.uid,operation,args.selected,Object.keys(provider.typeNames),name)
        if (updated && verificationFailure) {
          return $t("services.subscriptions.module.text_434203a723")+describe(provider)+"\n"+args.uid+$t("services.subscriptions.module.text_bb1bff7946")+verificationFailure+$t("services.subscriptions.module.text_46124aaeb6")
        }
        return updated ? $t("services.subscriptions.module.text_434203a723")+describe(provider)+"\n"+updated.name+"："+args.uid : $t("services.subscriptions.module.text_2d416c6b48")
      }
      if (view) {
        if (view[2] && !isSubscriptionOwner(context)) return $t("services.subscriptions.module.text_10d7776bfd")+describe(provider)+"。"
        if (!current && (!view[2] || context.message_type !== "terminal")) return $t("services.subscriptions.module.text_b4eb18acf3")
        const all=await config.routes(provider.id)
        if (!view[2] && current) return display(provider,all.filter(item=>item.kind===current.kind && item.chat===current.chat && item.bot===current.bot),describe(provider))
        const blocks=new Map<string, SubscriptionRoute[]>()
        for (const item of all) {
          if (current && item.bot !== current.bot) continue
          const name=(item.kind==="group"?$t("services.subscriptions.module.text_9eb20ff6ff"):$t("services.subscriptions.module.text_b571e46624"))+item.chat+$t("services.subscriptions.module.text_7a3b06c300")+item.bot
          let rows=blocks.get(name)
          if (!rows) { rows=[]; blocks.set(name,rows) }
          rows.push(item)
        }
        return blocks.size ? {type:"forward",nodes:[...blocks].map(([name,rows])=>display(provider,rows,name))} : describe(provider)+$t("services.subscriptions.module.text_a4f8a71872")
      }
      if (run) {
        if (!isSubscriptionOwner(context)) return $t("services.subscriptions.module.text_0d9d52ba44")+describe(provider)+$t("services.subscriptions.module.text_87043e5254")
        if (!getRedis()) return $t("services.subscriptions.module.text_b0bf4783ce")
        const task=dispatch.run(provider.id)
        if (!task) return $t("services.subscriptions.module.text_5fe9480d59")
        const record=await task
        return $t("services.subscriptions.module.text_18629a7841")+record.confirmed+$t("services.subscriptions.module.text_3d9ba31495")+record.rejected+$t("services.subscriptions.module.text_c47d1be66a")+record.unknown+
          $t("services.subscriptions.module.text_f4e551a98c")+record.skipped+$t("services.subscriptions.module.text_5fb6df0f47")+record.failed+$t("services.subscriptions.module.text_3b0770bdec")
      }
      const mode = lookup?.[2]?.toLowerCase()
      const query = lookup?.[3] ?? ""
      const value = mode === "uid" ? numericId(query) : query.trim()
      if (!value) return $t("services.subscriptions.module.text_f51da9f08c")
      const found=mode==="uid" ? [await provider.profile(value,{signal:services.signal})] :
        await provider.search?.(value,{signal:services.signal}) ?? []
      const rows=found.filter(value => value !== undefined).slice(0,8).map(profileText)
      return rows.length ? [{type:"text",text:rows.join("\n\n")}] : $t("services.subscriptions.module.text_e4bca02d33")
    } catch (error) {
      return describe(provider)+$t("services.subscriptions.module.text_ec33853944")+errorText(error)
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
