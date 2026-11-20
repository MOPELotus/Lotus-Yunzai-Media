import { setTimeout as pause } from "node:timers/promises"
import { Job } from "node-schedule"
import { makeDynamicMessages } from "./render.js"

const legacyPrefix = { bilibili:"bili", weibo:"weibo" }
const holdSeconds = 72 * 3600
export function receiptKey(platform, route, post) {
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

function allowedPost(post, route, settings, wall) {
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

function postNode(payloads) {
  return payloads.flatMap(payload => Array.isArray(payload) ? payload : [payload])
}

// Use the combined size of unrepeated posts for the destination and a strict threshold.
export function useDynamicForward(posts, settings) {
  if (!settings.mergeForward) return false
  let images = 0, textLength = 0
  for (const {payloads} of posts) {
    for (const part of postNode(payloads)) {
      if (typeof part === "string") textLength += part.length
      else if (part?.type === "image") images++
      else if (part?.type === "text") textLength += (part.text ?? part.data?.text ?? "").length
    }
  }
  return images > settings.forwardPictureThreshold || textLength > settings.forwardTextThreshold
}

function destinationKey(route) {
  return [route.kind,route.chat,route.bot].join(":")
}

export function createSubscriptionDelivery({providers,config,groups,notifications,getRedis,signal,now=Date.now,render=makeDynamicMessages}) {
  const controller = new AbortController()
  const active = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal
  const runs = new Map()
  const jobs = []

  async function senderFor(route, current, groupChecks) {
    const bot = Number(route.bot), chat = Number(route.chat)
    if (!Number.isSafeInteger(bot) || !Number.isSafeInteger(chat)) return
    const session = current.find(session => session.botId === bot)
    const forwardTarget = route.kind === "group" ? {groupId:chat} : {userId:chat}
    const forward = session?.sendForward ? nodes => session.sendForward(forwardTarget,nodes) : undefined
    if (route.kind === "private") {
      if (session && await session.isFriend(chat)) return {send:message=>session.sendPrivate(chat,message),forward}
      return
    }

    if (session) {
      if (await session.isGroupMember(chat,bot)) return {send:message=>session.sendGroup(chat,message),forward}
      return
    }
    if (groups?.onlineBots?.().includes(bot)) {
      const key = route.bot
      if (!groupChecks.has(key)) {
        groupChecks.set(key,groups.listGroups(bot)
          .then(values => new Set(values.map(value=>value.id))).catch(()=>new Set()))
      }
      if (!(await groupChecks.get(key)).has(chat)) return
      return {send:async message => {
        try { return Number.isSafeInteger(await groups.sendGroup(bot,chat,message)) ? "confirmed" : "unknown" }
        catch (error) { return error?.delivery === "not-sent" ? "rejected" : "unknown" }
      }}
    }
  }

  function finish(redis, entries, state) {
    return redis.eval(settleLua, { keys: entries.flatMap(item => [item.legacy, item.journal]),
      arguments: [state, ...entries.map(item => item.token)] })
  }

  async function claim(redis, candidates, report) {
    const entries = candidates.map(item => ({ ...item, token: "pending:" + crypto.randomUUID() }))
    try {
      const selected = await redis.eval(claimLua, { keys: entries.flatMap(item => [item.legacy, item.journal]),
        arguments: [String(holdSeconds), ...entries.map(item => item.token)] })
      if (!Array.isArray(selected) || selected.some(index => !Number.isInteger(index) || index < 1 || index > entries.length)) {
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

  async function sendSeparately(send,item) {
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

  async function notifyLiveAtAll(redis, route, sender, settings) {
    const mark = "Yz:yuki:bili:upPush:group:" + route.chat + ":liveAtAllMark"
    const token = "pending:" + crypto.randomUUID()
    const cooldown = settings.liveCooldown
    // Hold the claim through the gateway request even if the configured cooldown is short.
    if (await redis.set(mark,token,{NX:true,EX:Math.max(cooldown,120)}) !== "OK") return

    let state = "rejected"
    if (!active.aborted) {
      try { state = await sender.send([{type:"at",qq:"all"}," B站 直播提醒"]) }
      catch { state = "unknown" }
    }
    await redis.eval(settleLiveNoticeLua,{keys:[mark],arguments:[token,state,String(cooldown)]})
    if (state === "rejected" && !active.aborted && settings.liveFailureNotice) {
      await sender.send("直播动态发送@全体成员失败，请检查权限或平台是否支持")
    }
  }

  async function dispatchTarget(provider, redis, sender, entries, settings, report) {
    if (!entries.length) return
    const route = entries[0].route
    let liveNoticeAttempted = false
    async function liveNotice(claimed) {
      if (liveNoticeAttempted || active.aborted || provider.id !== "bilibili" || route.kind !== "group" || !settings.liveAtAll ||
          !settings.liveGroups.has(route.chat) || !claimed.some(item => item.post.type === "DYNAMIC_TYPE_LIVE_RCMD")) return
      liveNoticeAttempted = true
      try { await notifyLiveAtAll(redis, route, sender, settings) }
      catch { /* The dynamic itself is still deliverable. */ }
    }

    async function sendItems(items) {
      for (const item of items) {
        if (active.aborted) break
        const claimed = await claim(redis, [item], report)
        if (!claimed.length) continue
        await liveNotice(claimed)
        const state = await sendSeparately(sender.send, claimed[0])
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
      let status
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

  async function poll(provider) {
    const report = result()
    const redis = getRedis()
    if (!redis || active.aborted) return report
    const [settings,routes] = await Promise.all([config.settings(provider.id),config.routes(provider.id)])
    const current = notifications?.() ?? []
    const groupChecks = new Map(), destinations = new Map(), postsByUid = new Map()
    for (const route of routes) {
      const key = destinationKey(route)
      let list = destinations.get(key)
      if (!list) { list=[]; destinations.set(key,list) }
      list.push(route)
    }
    const wall = Math.floor(now()/1000)
    let requested = false
    async function postsFor(uid) {
      if (!postsByUid.has(uid)) {
        if (requested && settings.delay > 0) {
          const min = Math.min(settings.delay,2000)
          await pause(min + Math.floor(Math.random()*(settings.delay-min+1)),undefined,{signal:active})
        }
        requested = true
        try { postsByUid.set(uid,await provider.fetchPosts(uid,{signal:active,oldest:wall-settings.horizon})) }
        catch (error) {
          postsByUid.set(uid,[])
          if (!active.aborted) {
            report.failed++
            console.warn("[media] 订阅 · " + provider.label + "动态读取失败：" + error.message)
          }
        }
      }
      return postsByUid.get(uid)
    }
    for (const [target,subscriptions] of destinations) {
      if (active.aborted) break
      try {
        const sender = await senderFor(subscriptions[0],current,groupChecks)
        if (!sender) { report.skipped+=subscriptions.length; continue }
        const candidates = new Map()
        for (const route of subscriptions) {
          if (active.aborted) break
          for (const post of await postsFor(route.uid)) {
            if (active.aborted) break
            if (!allowedPost(post,route,settings,wall) || candidates.has(post.id)) continue
            const legacy = receiptKey(provider.id,route,post)
            const journal = "lotus-yunzai:media:subscription:" + provider.id + ":" + route.kind + ":" + route.chat + ":" + post.id
            if (await redis.get(legacy) !== null || await redis.get(journal) !== null) { report.skipped++; continue }
            try {
              const payloads=await render(provider,post,settings,{signal:active})
              candidates.set(post.id, { route, post, payloads, legacy, journal })
            } catch (error) {
              if (!active.aborted) {
                report.failed++
                console.warn("[media] 订阅 · " + provider.label + "动态构建失败：" + error.message)
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
          console.warn("[media] 订阅 · " + provider.label + "推送失败：" + error.message)
        }
      }
    }
    if (settings.log && (report.confirmed || report.unknown || report.failed)) {
      console.info("[media] 订阅 · " + provider.label + " 已确认 " + report.confirmed + "，未确认 " + report.unknown + "，异常 " + report.failed)
    }
    return report
  }

  function run(id, automatic=false) {
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
      for (const id of Object.keys(providers)) {
        try {
          const settings = await config.settings(id)
          if (!settings.enable || active.aborted) continue
          const job = new Job(() => { void run(id,true)?.catch(error => console.warn("[media] 订阅 · " + error.message)) })
          if (!job.schedule({rule:settings.cron,tz:"Asia/Shanghai"})) throw new Error("定时配置无效")
          jobs.push(job)
        } catch (error) { console.warn("[media] 订阅 · " + providers[id].label + " " + error.message) }
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
