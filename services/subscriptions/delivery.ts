import { setTimeout as pause } from "node:timers/promises"
import { Job } from "node-schedule"
import type { GroupTransport } from "../../../../lib/adapters/onebot-groups.ts"
import type { BotNotifications, CheckinNotifyDelivery } from "../../../../lib/checkin-notify.ts"
import type { MessageReply } from "../../../../lib/messages.ts"
import type { createSubscriptionConfig, SubscriptionRoute, SubscriptionSettings } from "./config.ts"
import { makeDynamicMessages } from "./render.ts"
import type { DynamicPost, GetSubscriptionRedis, SubscriptionPlatform, SubscriptionProvider, SubscriptionProviders, SubscriptionRedis } from "./types.ts"

export type SubscriptionGroups = Pick<GroupTransport, "onlineBots" | "listGroups" | "sendGroup">

interface DeliveryOptions {
  providers: SubscriptionProviders
  config: Pick<ReturnType<typeof createSubscriptionConfig>, "settings" | "routes">
  groups?: SubscriptionGroups
  notifications?: () => readonly BotNotifications[]
  getRedis: GetSubscriptionRedis
  signal?: AbortSignal
  now?: () => number
  render?: typeof makeDynamicMessages
}

interface Candidate {
  route: SubscriptionRoute
  post: DynamicPost
  payloads: readonly MessageReply[]
  legacy: string
  journal: string
}
type Claim = Candidate & { token: string }
type Report = ReturnType<typeof result>
type Send = (message: MessageReply) => Promise<CheckinNotifyDelivery>
interface Sender {
  send: Send
  inlineImageByteLimit?: number
  forward?: (nodes: readonly MessageReply[]) => Promise<CheckinNotifyDelivery>
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

const legacyPrefix = { bilibili:"bili", weibo:"weibo" }
const holdSeconds = 72 * 3600
export function receiptKey(platform: SubscriptionPlatform, route: Pick<SubscriptionRoute, "kind" | "chat">, post: Pick<DynamicPost, "id">) {
  return "Yz:yuki:" + legacyPrefix[platform] + ":upPush:" + route.kind + ":" + route.chat + ":" + post.id
}

const claimLua = `
local claimed = {}
for i = 1, #ARGV - 1 do
  local legacy, journal = KEYS[i * 2 - 1], KEYS[i * 2]
  if redis.call('EXISTS', legacy, journal) == 0 then
    local token = ARGV[i + 1]
    redis.call('SET', legacy, token, 'EX', ARGV[1])
    redis.call('SET', journal, token, 'EX', ARGV[1])
    table.insert(claimed, i)
  end
end
return claimed`
const settleLua = `
local state = ARGV[1]
for i = 1, #ARGV - 1 do
  local legacy, journal = KEYS[i * 2 - 1], KEYS[i * 2]
  local token = ARGV[i + 1]
  if state == 'rejected' then
    if redis.call('GET', legacy) == token then redis.call('DEL', legacy) end
    if redis.call('GET', journal) == token then redis.call('DEL', journal) end
  elseif redis.call('GET', journal) == token then
    if redis.call('GET', legacy) == token then redis.call('SET', legacy, '1', 'KEEPTTL') end
    redis.call('SET', journal, state, 'KEEPTTL')
  end
end
return 1`
const settleLiveNoticeLua = [
  "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end",
  "if ARGV[2]=='rejected' then return redis.call('DEL',KEYS[1]) end",
  "redis.call('SET',KEYS[1],'1','EX',ARGV[3])",
  "return 1",
].join("\n")

function allowedPost(post: DynamicPost, route: SubscriptionRoute, settings: SubscriptionSettings, wall: number) {
  if (!post?.id || post.uid !== route.uid || !Number.isSafeInteger(post.createdAt) ||
      post.createdAt > wall || post.createdAt < wall - settings.horizon ||
      post.type === "DYNAMIC_TYPE_FORWARD" && !settings.forwards ||
      route.types.length && !route.types.includes(post.type)) return false
  const fields = [post.title,post.content,post.forwarded?.title,post.forwarded?.content]
  if (!settings.picture) fields.push(post.url,post.forwarded?.url)
  const content = fields.filter(Boolean).join("\n")
  return (!settings.whitelist.length || settings.whitelist.some(word => content.includes(word))) &&
    !settings.blacklist.some(word => content.includes(word))
}

function result() {
  return { confirmed:0, rejected:0, unknown:0, skipped:0, failed:0 }
}

const maxForwardPosts = 99

function postNode(payloads: readonly MessageReply[]) {
  return payloads.flat()
}

// Use the combined size of unrepeated posts for the destination and a strict threshold.
export function useDynamicForward(posts: readonly Pick<Candidate, "payloads">[], settings: SubscriptionSettings) {
  if (!settings.mergeForward) return false
  let images = 0, textLength = 0
  for (const {payloads} of posts) {
    for (const part of postNode(payloads)) {
      if (typeof part === "string") textLength += part.length
      else if (part?.type === "image") images++
      else if (part?.type === "text") {
        const text = "text" in part ? part.text : part.data?.text
        if (typeof text === "string") textLength += text.length
      }
    }
  }
  return images > settings.forwardPictureThreshold || textLength > settings.forwardTextThreshold
}

function destinationKey(route: SubscriptionRoute) {
  return [route.kind,route.chat,route.bot].join(":")
}

export function createSubscriptionDelivery({providers,config,groups,notifications,getRedis,signal,now=Date.now,render=makeDynamicMessages}: DeliveryOptions) {
  const controller = new AbortController()
  const active = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal
  const runs = new Map<SubscriptionPlatform, Promise<Report>>()
  const jobs: Job[] = []

  async function senderFor(route: SubscriptionRoute, current: readonly BotNotifications[],
    groupChecks: Map<string, Promise<Set<number>>>): Promise<Sender | undefined> {
    const bot = Number(route.bot), chat = Number(route.chat)
    if (!Number.isSafeInteger(bot) || !Number.isSafeInteger(chat)) return
    const session = current.find(session => session.botId === bot)
    const forwardTarget = route.kind === "group" ? {groupId:chat} : {userId:chat}
    const forward = session?.sendForward?.bind(session, forwardTarget)
    const inlineImageByteLimit = session?.inlineImageByteLimit
    if (route.kind === "private") {
      if (session && await session.isFriend(chat)) return {send:message=>session.sendPrivate(chat,message),forward,inlineImageByteLimit}
      return
    }

    if (session) {
      if (await session.isGroupMember(chat,bot)) return {send:message=>session.sendGroup(chat,message),forward,inlineImageByteLimit}
      return
    }
    if (groups?.onlineBots?.().includes(bot)) {
      const key = route.bot
      let membership = groupChecks.get(key)
      if (!membership) {
        membership = groups.listGroups(bot)
          .then(values => new Set(values.map(value=>value.id))).catch(()=>new Set<number>())
        groupChecks.set(key, membership)
      }
      if (!(await membership).has(chat)) return
      return {send:async message => {
        try { return Number.isSafeInteger(await groups.sendGroup(bot,chat,message)) ? "confirmed" : "unknown" }
        catch (error) { return error && typeof error === "object" && "delivery" in error && error.delivery === "not-sent" ? "rejected" : "unknown" }
      }}
    }
  }

  function finish(redis: SubscriptionRedis, entries: readonly Claim[], state: CheckinNotifyDelivery) {
    return redis.eval(settleLua, { keys: entries.flatMap(item => [item.legacy, item.journal]),
      arguments: [state, ...entries.map(item => item.token)] })
  }

  async function claim(redis: SubscriptionRedis, candidates: readonly Candidate[], report: Report): Promise<Claim[]> {
    const entries = candidates.map(item => ({ ...item, token: "pending:" + crypto.randomUUID() }))
    try {
      const selected = await redis.eval(claimLua, { keys: entries.flatMap(item => [item.legacy, item.journal]),
        arguments: [String(holdSeconds), ...entries.map(item => item.token)] })
      if (!Array.isArray(selected) || selected.some(index => typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > entries.length)) {
        throw new Error("动态投递占位结果无效。")
      }
      const claimed = new Set(selected)
      report.skipped += entries.length - claimed.size
      return entries.filter((_, index) => claimed.has(index + 1))
    } catch (error) {
      // Nothing has reached the gateway. Release only our token if the write actually landed.
      await finish(redis, entries, "rejected").catch(() => {})
      throw error
    }
  }

  async function sendSeparately(send: Send, item: Candidate): Promise<CheckinNotifyDelivery> {
    let sent = 0
    for (const payload of item.payloads) {
      if (active.aborted) return sent ? "unknown" : "rejected"
      try {
        const state = await send(payload)
        if (state !== "confirmed") return state === "rejected" && !sent ? "rejected" : "unknown"
        sent++
      } catch { return "unknown" }
    }
    return sent ? "confirmed" : "rejected"
  }

  async function notifyLiveAtAll(redis: SubscriptionRedis, route: SubscriptionRoute, sender: Sender, settings: SubscriptionSettings) {
    const mark = "Yz:yuki:bili:upPush:group:" + route.chat + ":liveAtAllMark"
    const token = "pending:" + crypto.randomUUID()
    const cooldown = settings.liveCooldown
    // Hold the claim through the gateway request even if the configured cooldown is short.
    if (await redis.set(mark,token,{NX:true,EX:Math.max(cooldown,120)}) !== "OK") return

    let state: CheckinNotifyDelivery = "rejected"
    if (!active.aborted) {
      try { state = await sender.send([{type:"at",qq:"all"}," B站 直播提醒"]) }
      catch { state = "unknown" }
    }
    await redis.eval(settleLiveNoticeLua,{keys:[mark],arguments:[token,state,String(cooldown)]})
    if (state === "rejected" && !active.aborted && settings.liveFailureNotice) {
      await sender.send("直播动态发送@全体成员失败，请检查权限或平台是否支持")
    }
  }

  async function dispatchTarget(provider: SubscriptionProvider, redis: SubscriptionRedis, sender: Sender,
    entries: readonly Candidate[], settings: SubscriptionSettings, report: Report) {
    const first = entries[0]
    if (!first) return
    const route = first.route
    let liveNoticeAttempted = false
    async function liveNotice(claimed: readonly Claim[]) {
      if (liveNoticeAttempted || active.aborted || provider.id !== "bilibili" || route.kind !== "group" || !settings.liveAtAll ||
          !settings.liveGroups.has(route.chat) || !claimed.some(item => item.post.type === "DYNAMIC_TYPE_LIVE_RCMD")) return
      liveNoticeAttempted = true
      try { await notifyLiveAtAll(redis, route, sender, settings) }
      catch { /* The dynamic itself is still deliverable. */ }
    }

    async function sendItems(items: readonly Candidate[]) {
      for (const item of items) {
        if (active.aborted) break
        const claimed = await claim(redis, [item], report)
        const entry = claimed[0]
        if (!entry) continue
        await liveNotice(claimed)
        const state = await sendSeparately(sender.send, entry)
        await finish(redis, claimed, state)
        report[state]++
      }
    }

    if (!sender.forward || !useDynamicForward(entries, settings)) {
      await sendItems(entries)
      return
    }

    for (let index = 0; index < entries.length && !active.aborted; index += maxForwardPosts) {
      const batch = await claim(redis, entries.slice(index, index + maxForwardPosts), report)
      if (!batch.length) continue
      if (entries.length <= maxForwardPosts && batch.length !== entries.length && !useDynamicForward(batch, settings)) {
        await finish(redis, batch, "rejected")
        await sendItems(batch)
        continue
      }
      await liveNotice(batch)
      if (active.aborted) {
        await finish(redis, batch, "rejected")
        break
      }
      let status: CheckinNotifyDelivery
      try { status = await sender.forward(["有新的"+provider.label+"动态了~", ...batch.map(item => postNode(item.payloads))]) }
      catch { status = "unknown" }
      if (status === "rejected") {
        await finish(redis, batch, "rejected")
        await sendItems(batch)
      } else {
        const state = status === "confirmed" ? "confirmed" : "unknown"
        await finish(redis, batch, state)
        report[state] += batch.length
      }
    }
  }

  async function poll(provider: SubscriptionProvider) {
    const report = result()
    const redis = getRedis()
    if (!redis || active.aborted) return report
    const [settings,routes] = await Promise.all([config.settings(provider.id),config.routes(provider.id)])
    const current = notifications?.() ?? []
    const groupChecks = new Map<string, Promise<Set<number>>>()
    const destinations = new Map<string, SubscriptionRoute[]>()
    const postsByUid = new Map<string, readonly DynamicPost[]>()
    for (const route of routes) {
      const key = destinationKey(route)
      let list = destinations.get(key)
      if (!list) { list=[]; destinations.set(key,list) }
      list.push(route)
    }
    const wall = Math.floor(now()/1000)
    let requested = false
    async function postsFor(uid: string): Promise<readonly DynamicPost[]> {
      const cached = postsByUid.get(uid)
      if (cached) return cached
      if (requested && settings.delay > 0) {
        const min = Math.min(settings.delay,2000)
        await pause(min + Math.floor(Math.random()*(settings.delay-min+1)),undefined,{signal:active})
      }
      requested = true
      let posts: readonly DynamicPost[]
      try { posts = await provider.fetchPosts(uid,{signal:active,oldest:wall-settings.horizon}) }
      catch (error) {
        posts = []
        if (!active.aborted) {
          report.failed++
          console.warn("[media] 订阅 · " + provider.label + "动态读取失败：" + errorText(error))
        }
      }
      postsByUid.set(uid, posts)
      return posts
    }
    for (const [target,subscriptions] of destinations) {
      if (active.aborted) break
      try {
        const first = subscriptions[0]
        if (!first) continue
        const sender = await senderFor(first,current,groupChecks)
        if (!sender) { report.skipped+=subscriptions.length; continue }
        const candidates = new Map<string, Candidate>()
        for (const route of subscriptions) {
          if (active.aborted) break
          for (const post of await postsFor(route.uid)) {
            if (active.aborted) break
            if (!allowedPost(post,route,settings,wall) || candidates.has(post.id)) continue
            const legacy = receiptKey(provider.id,route,post)
            const journal = "lotus-yunzai:media:subscription:" + provider.id + ":" + route.kind + ":" + route.chat + ":" + post.id
            if (await redis.get(legacy) !== null || await redis.get(journal) !== null) { report.skipped++; continue }
            try {
              const payloads=await render(provider,post,settings,{signal:active,inlineImageByteLimit:sender.inlineImageByteLimit})
              candidates.set(post.id, { route, post, payloads, legacy, journal })
            } catch (error) {
              if (!active.aborted) {
                report.failed++
                console.warn("[media] 订阅 · " + provider.label + "动态构建失败：" + errorText(error))
              }
            }
          }
        }
        if (!candidates.size || active.aborted) continue
        const currentRoutes = (await config.routes(provider.id)).filter(route=>destinationKey(route)===target)
        const entries = [...candidates.values()]
          .filter(({ post }) => currentRoutes.some(route => route.uid === post.uid && (!route.types.length || route.types.includes(post.type))))
          .sort((a, b) => a.post.createdAt - b.post.createdAt)
        await dispatchTarget(provider,redis,sender,entries,settings,report)
      } catch (error) {
        if (!active.aborted) {
          report.failed++
          console.warn("[media] 订阅 · " + provider.label + "推送失败：" + errorText(error))
        }
      }
    }
    if (settings.log && (report.confirmed || report.unknown || report.failed)) {
      console.info("[media] 订阅 · " + provider.label + " 已确认 " + report.confirmed + "，未确认 " + report.unknown + "，异常 " + report.failed)
    }
    return report
  }

  function run(id: SubscriptionPlatform, automatic = false) {
    const provider = providers[id]
    if (!provider || active.aborted || runs.has(id)) return
    const task = (async () => {
      if (automatic && !(await config.settings(id)).enable) return result()
      return poll(provider)
    })().finally(() => runs.delete(id))
    runs.set(id,task)
    return task
  }

  function cancel() { for (const job of jobs) job.cancel() }
  active.addEventListener("abort",cancel,{once:true})
  return {
    run,
    async start() {
      if (!getRedis() || active.aborted) return
      for (const provider of Object.values(providers)) {
        if (!provider) continue
        const { id } = provider
        try {
          const settings = await config.settings(id)
          if (!settings.enable || active.aborted) continue
          const job = new Job(() => { void run(id,true)?.catch(error => console.warn("[media] 订阅 · " + errorText(error))) })
          if (!job.schedule({rule:settings.cron,tz:"Asia/Shanghai"})) throw new Error("定时配置无效")
          jobs.push(job)
        } catch (error) { console.warn("[media] 订阅 · " + provider.label + " " + errorText(error)) }
      }
    },
    async dispose() {
      controller.abort()
      cancel()
      active.removeEventListener("abort",cancel)
      await Promise.allSettled(runs.values())
    },
  }
}
