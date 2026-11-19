import { setTimeout as pause } from "node:timers/promises"
import { Job } from "node-schedule"
import { makeDynamicMessages } from "./render.js"

const legacyPrefix = { bilibili:"bili", weibo:"weibo" }
const holdSeconds = 72 * 3600
export function receiptKey(platform, route, post) {
  return "Yz:yuki:" + legacyPrefix[platform] + ":upPush:" + route.kind + ":" + route.chat + ":" + post.id
}

const claimLua = [
  "if redis.call('EXISTS',KEYS[1])==1 or redis.call('EXISTS',KEYS[2])==1 then return 0 end",
  "redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2])",
  "redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[2])",
  "return 1",
].join("\n")
const settleLua = [
  "if redis.call('GET',KEYS[2])~=ARGV[1] then return 0 end",
  "if ARGV[2]=='rejected' then",
  "  if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1]) end",
  "  redis.call('DEL',KEYS[2])",
  "else",
  "  if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[1],'1','KEEPTTL') end",
  "  redis.call('SET',KEYS[2],ARGV[2],'KEEPTTL')",
  "end",
  "return 1",
].join("\n")

function allowedPost(post, route, settings, wall) {
  if (!post?.id || post.uid !== route.uid || !Number.isSafeInteger(post.createdAt) ||
      post.createdAt > wall || post.createdAt < wall - settings.horizon ||
      post.type === "DYNAMIC_TYPE_FORWARD" && !settings.forwards ||
      route.types.length && !route.types.includes(post.type)) return false
  const content = [post.title,post.content,post.forwarded?.title,post.forwarded?.content].filter(Boolean).join("\n")
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

// Yuki aggregates all unrepeated posts in the destination, using a strict threshold.
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

  async function finish(redis, item, state) {
    await redis.eval(settleLua,{keys:item.keys,arguments:[item.token,state]})
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

  async function dispatchTarget(provider, redis, sender, entries, settings, report) {
    if (!entries.length) return
    const route=entries[0].route
    if (!active.aborted && route.kind === "group" && settings.liveAtAll && settings.liveGroups.has(route.chat) &&
        entries.some(entry=>entry.post.type === "DYNAMIC_TYPE_LIVE_RCMD")) {
      const mark = "Yz:yuki:bili:upPush:group:" + route.chat + ":liveAtAllMark"
      try {
        if (await redis.set(mark,"1",{NX:true,EX:settings.liveCooldown}) === "OK") {
          await sender.send([{type:"at",qq:"all"}," "+provider.label+" 直播提醒"])
        }
      } catch { /* The dynamic itself is still deliverable. */ }
    }

    if (sender.forward && useDynamicForward(entries,settings)) {
      for (let index=0;index<entries.length;index+=maxForwardPosts) {
        const batch=entries.slice(index,index+maxForwardPosts)
        let status = "rejected"
        if (!active.aborted) {
          try { status = await sender.forward(["有新的"+provider.label+"动态了~",...batch.map(item=>postNode(item.payloads))]) }
          catch { status = "unknown" }
        }
        for (const item of batch) {
          const state = status === "rejected" ? await sendSeparately(sender.send,item) : status === "confirmed" ? "confirmed" : "unknown"
          await finish(redis,item,state)
          report[state]++
        }
      }
      return
    }
    for (const item of entries) {
      const state = await sendSeparately(sender.send,item)
      await finish(redis,item,state)
      report[state]++
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
            console.warn("[媒体订阅] " + provider.label + "动态读取失败：" + error.message)
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
            if (await redis.get(legacy) !== null) { report.skipped++; continue }
            try {
              const payloads=await render(provider,post,settings,{signal:active})
              candidates.set(post.id,{route,post,payloads,legacy})
            } catch (error) {
              if (!active.aborted) {
                report.failed++
                console.warn("[媒体订阅] " + provider.label + "动态构建失败：" + error.message)
              }
            }
          }
        }
        if (!candidates.size || active.aborted) continue
        const currentRoutes = (await config.routes(provider.id)).filter(route=>destinationKey(route)===target)
        const entries=[]
        try {
          for (const item of [...candidates.values()].sort((a,b)=>a.post.createdAt-b.post.createdAt)) {
            if (active.aborted) break
            const {post,route,legacy}=item
            if (!currentRoutes.some(route=>route.uid===post.uid && (!route.types.length || route.types.includes(post.type)))) continue
            const journal = "lotus-yunzai:media:subscription:" + provider.id + ":" + route.kind + ":" + route.chat + ":" + post.id
            const token = "pending:" + crypto.randomUUID()
            const keys = [legacy,journal]
            if (await redis.eval(claimLua,{keys,arguments:[token,String(holdSeconds)]}) !== 1) { report.skipped++; continue }
            entries.push({...item,token,keys})
          }
        } catch (error) {
          await Promise.allSettled(entries.map(item=>finish(redis,item,"rejected")))
          throw error
        }
        await dispatchTarget(provider,redis,sender,entries,settings,report)
      } catch (error) {
        if (!active.aborted) {
          report.failed++
          console.warn("[媒体订阅] " + provider.label + "推送失败：" + error.message)
        }
      }
    }
    if (settings.log && (report.confirmed || report.unknown || report.failed)) {
      console.info("[媒体订阅] " + provider.label + " 已确认 " + report.confirmed + "，未确认 " + report.unknown + "，异常 " + report.failed)
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
          const job = new Job(() => { void run(id,true)?.catch(error => console.warn("[媒体订阅] " + error.message)) })
          if (!job.schedule({rule:settings.cron,tz:"Asia/Shanghai"})) throw new Error("定时配置无效")
          jobs.push(job)
        } catch (error) { console.warn("[媒体订阅] " + providers[id].label + " " + error.message) }
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
