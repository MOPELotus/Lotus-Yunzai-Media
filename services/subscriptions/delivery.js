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
    if (route.kind === "private") {
      if (session && await session.isFriend(chat)) return message => session.sendPrivate(chat,message)
      return
    }

    if (session) {
      if (await session.isGroupMember(chat,bot)) return message => session.sendGroup(chat,message)
      return
    }
    if (groups?.onlineBots?.().includes(bot)) {
      const key = route.bot
      if (!groupChecks.has(key)) {
        groupChecks.set(key,groups.listGroups(bot)
          .then(values => new Set(values.map(value=>value.id))).catch(()=>new Set()))
      }
      if (!(await groupChecks.get(key)).has(chat)) return
      return async message => {
        try { return Number.isSafeInteger(await groups.sendGroup(bot,chat,message)) ? "confirmed" : "unknown" }
        catch (error) { return error?.delivery === "not-sent" ? "rejected" : "unknown" }
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
    const wall = Math.floor(now()/1000)
    let requested = false
    for (const route of routes) {
      if (active.aborted) break
      const target = destinationKey(route)
      try {
        if (!destinations.has(target)) destinations.set(target,await senderFor(route,current,groupChecks))
        const send = destinations.get(target)
        if (!send) { report.skipped++; continue }
        if (!postsByUid.has(route.uid)) {
          if (requested && settings.delay > 0) {
            const min = Math.min(settings.delay,2000)
            await pause(min + Math.floor(Math.random()*(settings.delay-min+1)),undefined,{signal:active})
          }
          requested = true
          try { postsByUid.set(route.uid,await provider.fetchPosts(route.uid,{signal:active,oldest:wall-settings.horizon})) }
          catch (error) {
            postsByUid.set(route.uid,[])
            if (!active.aborted) {
              report.failed++
              console.warn("[媒体订阅] " + provider.label + "动态读取失败：" + error.message)
            }
          }
        }
        const posts = postsByUid.get(route.uid)
        for (const post of [...posts].sort((a,b)=>a.createdAt-b.createdAt)) {
          if (active.aborted) return report
          if (!allowedPost(post,route,settings,wall)) continue
          const legacy = receiptKey(provider.id,route,post)
          const journal = "lotus-yunzai:media:subscription:" + provider.id + ":" + route.kind + ":" + route.chat + ":" + post.id
          if (await redis.get(legacy) !== null) { report.skipped++; continue }
          const payloads = await render(provider,post,settings,{signal:active})
          const currentRoutes = await config.routes(provider.id)
          if (active.aborted || !currentRoutes.some(item => destinationKey(item) === target && item.uid === post.uid &&
              (!item.types.length || item.types.includes(post.type)))) continue
          const token = "pending:" + crypto.randomUUID()
          const keys = [legacy,journal]
          if (await redis.eval(claimLua,{keys,arguments:[token,String(holdSeconds)]}) !== 1) { report.skipped++; continue }
          let state = "rejected", sent = 0
          try {
            if (!active.aborted && route.kind === "group" && post.type === "DYNAMIC_TYPE_LIVE_RCMD" &&
                settings.liveAtAll && settings.liveGroups.has(route.chat)) {
              const mark = "Yz:yuki:bili:upPush:group:" + route.chat + ":liveAtAllMark"
              if (await redis.set(mark,"1",{NX:true,EX:settings.liveCooldown}) === "OK") {
                try { await send([{type:"at",qq:"all"}," "+provider.label+" 直播提醒"]) }
                catch { /* The dynamic itself is still deliverable. */ }
              }
            }
            for (const payload of payloads) {
              if (active.aborted) { state = sent ? "unknown" : "rejected"; break }
              const next = await send(payload)
              if (next !== "confirmed") {
                state = next === "rejected" && !sent ? "rejected" : "unknown"
                break
              }
              state = "confirmed"
              sent++
            }
          } catch { state = "unknown" }
          await redis.eval(settleLua,{keys,arguments:[token,state]})
          report[state]++
        }
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
