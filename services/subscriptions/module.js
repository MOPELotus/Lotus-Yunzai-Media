import { fileURLToPath } from "node:url"
import { createBiliProvider } from "./bilibili/index.js"
import { createWeiboProvider } from "./weibo/index.js"
import { createSubscriptionConfig, numericId } from "./config.js"
import { createSubscriptionDelivery } from "./delivery.js"
import { profileText } from "./profile.js"
import { renderSubscriptionHelp } from "./help.js"

const dataDirectory = fileURLToPath(new URL("../../../../data",import.meta.url))
const prefix = /^(?:#|\/)(?:yuki|优纪)?/iu
const help = /^(?:#|\/)(?:yuki|优纪)帮助$/iu
const platformName = "(哔哩哔哩|哔哩|bilibili|bili|b站|微博|weibo)"
const edit = new RegExp("^(订阅|添加|add|取消|删除|del)"+platformName+"推送\\s*(.*)$","iu")
const list = new RegExp("^"+platformName+"(全部)?(?:推送|动态|订阅)列表$","iu")
const manual = new RegExp("^执行"+platformName+"任务$","iu")
const profile = new RegExp("^"+platformName+"(?:up|up主|博主|bo主)(uid|昵称)\\s*[:：]?\\s*(.*)$","iu")
const categories = /^(视频|图文|文章|转发|直播)\s*/u

function platform(value) {
  return /^(微博|weibo)$/iu.test(value) ? "weibo" : "bilibili"
}

function target(context) {
  const kind = context.message_type
  if (kind !== "group" && kind !== "private") return
  const chat = numericId(kind === "group" ? context.group_id : context.user_id)
  const bot = numericId(context.self_id)
  if (chat && bot) return { kind,chat,bot }
}

function isSubscriptionOwner(context) {
  if (context.adapter !== "milky") return context.isMaster === true
  const user = context.user_id
  return context.isDelegated !== true && Number.isSafeInteger(user) && user > 0 && context.isBotMaster?.(user) === true
}

function editArguments(input,provider) {
  const selected = new Set()
  let rest = input.trim()
  for (let match; (match=categories.exec(rest));) {
    for (const [code,label] of Object.entries(provider.typeNames)) if (label === match[1]) selected.add(code)
    if (![...Object.values(provider.typeNames)].includes(match[1])) return
    rest = rest.slice(match[0].length)
  }
  rest = rest.replace(/^(?:uid\s*)?[:：]?\s*/iu,"")
  const uid = numericId(rest)
  if (uid) return {uid,selected:[...selected]}
}

function display(provider,items,heading) {
  if (!items.length) return heading+"\n当前没有订阅。"
  return heading+"\n"+items.map(item=>{
    const types = [...new Set(item.types.map(type=>provider.typeNames[type]).filter(Boolean))]
    return item.uid+"："+item.name+" ["+(types.length?types.join("、"):"全部动态")+"]"
  }).join("\n")
}

export async function createSubscriptionModule(services, { providers = {bilibili:createBiliProvider(),weibo:createWeiboProvider()}, directory=dataDirectory,
  getRedis=()=>globalThis.redis, render, now, renderHelp=renderSubscriptionHelp } = {}) {
  const config = createSubscriptionConfig(directory,services.lockFile)
  const dispatch = createSubscriptionDelivery({ providers,config,groups:services.groups,notifications:services.subscriptionTransport,
    getRedis,signal:services.signal,render,now })
  await dispatch.start()
  const describe = provider => provider.label + "订阅"

  async function fallback(message,context) {
    if (help.test(message.trim())) return renderHelp()
    if (!prefix.test(message)) return
    const command=message.replace(prefix,"").trim()
    const match=edit.exec(command)
    const view=list.exec(command)
    const run=manual.exec(command)
    const lookup=profile.exec(command)
    const selected=match?.[2]||view?.[1]||run?.[1]||lookup?.[1]
    if (!selected) return
    const provider=providers[platform(selected)]
    if (!provider) return
    const current=target(context)
    try {
      if (match) {
        if (!isSubscriptionOwner(context)) return "只有机器人主人可以修改"+describe(provider)+"。"
        if (!current) return "请在订阅要发送的群聊或私聊中设置。"
        const args=editArguments(match[3],provider)
        if (!args) return "请在指令末尾填写有效的纯数字 UID。"
        const operation=/^(删除|取消|del)$/iu.test(match[1])?"remove":"add"
        let name=args.uid
        if (operation === "add" && !(await config.routes(provider.id)).some(item=>
          item.uid === args.uid && item.bot === current.bot && item.chat === current.chat && item.kind === current.kind)) {
          try {
            const info=await provider.profile(args.uid,{signal:services.signal})
            if (!info) return "未找到 UID "+args.uid+" 的公开资料。"
            name=info.name
          } catch (error) {
            return provider.label+"用户校验失败："+error.message
          }
        }
        const updated=await config.update(provider.id,current,args.uid,operation,args.selected,Object.keys(provider.typeNames),name)
        return updated ? "已更新"+describe(provider)+"\n"+updated.name+"："+args.uid : "当前会话没有订阅该 UID。"
      }
      if (view) {
        if (view[2] && !isSubscriptionOwner(context)) return "只有机器人主人可以查看全部"+describe(provider)+"。"
        if (!current && (!view[2] || context.message_type !== "terminal")) return "请在群聊或私聊中查询当前会话。"
        const all=await config.routes(provider.id)
        if (!view[2]) return display(provider,all.filter(item=>item.kind===current.kind && item.chat===current.chat && item.bot===current.bot),describe(provider))
        const blocks=new Map()
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
      const value=lookup[2].toLowerCase()==="uid"?numericId(lookup[3]):lookup[3].trim()
      if (!value) return "请输入要查询的 UID 或昵称。"
      const found=lookup[2].toLowerCase()==="uid" ? [await provider.profile(value,{signal:services.signal})] :
        await provider.search?.(value,{signal:services.signal}) ?? []
      const rows=found.filter(Boolean).slice(0,8).map(profileText)
      return rows.length ? [{type:"text",text:rows.join("\n\n")}] : "没有找到公开用户资料。"
    } catch (error) {
      return describe(provider)+"处理失败："+error.message
    }
  }
  return { commands:{}, fallback,dispose:dispatch.dispose }
}
