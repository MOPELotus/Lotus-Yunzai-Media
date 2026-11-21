import { setTimeout as delay } from "node:timers/promises"
import { loadGlobalConfig } from "../../core/config/global.js"
import { formatLocalIso } from "../../core/time.js"
import { TuneWeaveService } from "../tuneweave/service.js"
import { NeteasePartnerTask } from "./partner-task.js"

const defaultSchedule = "0 5 0 * * ? *"

export function partnerCron(value) {
  if (value == null || value === "") value = defaultSchedule
  if (typeof value !== "string") throw new Error("合伙人定时配置须为 cron 表达式")
  const fields = value.trim().split(/\s+/u)
  if (fields.length === 7 && fields[6] === "*") fields.pop()
  if (fields.length === 5) fields.unshift("0")
  if (fields.length !== 6) throw new Error("合伙人定时配置需要五段或六段 cron 表达式")
  for (const index of [3,5]) if (fields[index] === "?") fields[index] = "*"
  return fields.join(" ")
}

function pastPartnerSlot(config, now) {
  if (config?.enable !== true || config.auto_catch_up !== true) return false
  const match = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \* \*$/u.exec(partnerCron(config.schedule))
  if (!match) return false
  const [seconds, minutes, hours] = match.slice(1).map(Number)
  if (seconds >= 60 || minutes >= 60 || hours >= 24) return false
  const slot = new Date(now)
  slot.setHours(hours, minutes, seconds, 0)
  return now > slot
}

export async function createPartnerSchedule({ mediaRuntime, signal }, {
  execute, render, load = loadGlobalConfig, now = () => new Date(),
  hasRunToday = () => new NeteasePartnerTask().hasRunToday(),
  ensureReady = (config, active) => new TuneWeaveService({ config:config.tuneweave }).requireReady("netease", active),
  wait = (ms, active) => delay(ms, undefined, { signal:active, ref:false }),
} = {}) {
  if (!mediaRuntime || signal?.aborted || mediaRuntime.disconnect?.aborted) return
  const controller = new AbortController()
  const active = AbortSignal.any([controller.signal, signal, mediaRuntime.disconnect].filter(Boolean))
  let unregister, cancelReady, pending, startup
  let ready = false
  const logFailure = () => {
    if (!active.aborted) console.warn("[media] 合伙人自动任务未完成，请检查 TuneWeave 状态和最近日志。")
  }

  function run(trigger, startupDay) {
    if (!ready || active.aborted || pending) return pending
    pending = (async () => {
      const config = await load()
      if (active.aborted || config.netease_partner?.enable !== true) return
      if (startupDay && (startupDay !== formatLocalIso(now()).slice(0,10) ||
        !pastPartnerSlot(config.netease_partner, now()))) return
      if (await hasRunToday() || active.aborted) return
      if (startupDay) await ensureReady(config, active)
      if (active.aborted) return
      const report = await execute(config, trigger, { signal:active, once:true })
      if (active.aborted || report.skipped || config.netease_partner.notify_master === false || !mediaRuntime.notifyMasters) return report
      const { image, text } = await render("合伙人自动任务", report)
      if (!active.aborted) await mediaRuntime.notifyMasters(image ? { type:"image", file:image } : text, active)
      return report
    })().catch(logFailure).finally(() => { pending = undefined })
    return pending
  }

  try {
    const config = await load()
    if (active.aborted) return
    unregister = mediaRuntime.registerTask(partnerCron(config.netease_partner?.schedule), async () => run("自动任务"))
    cancelReady = mediaRuntime.whenReady(() => {
      if (active.aborted) return
      ready = true
      startup = (async () => {
        const current = await load()
        const currentTime = now()
        if (active.aborted || !pastPartnerSlot(current.netease_partner, currentTime) || await hasRunToday()) return
        await wait(60000, active)
        await run("启动补跑", formatLocalIso(currentTime).slice(0,10))
      })().catch(logFailure)
    })
  } catch {
    await unregister?.()
    if (!active.aborted) console.warn("[media] 合伙人定时配置无法读取或注册。")
    return
  }

  return async () => {
    controller.abort()
    cancelReady?.()
    await Promise.allSettled([unregister?.(), pending, startup])
  }
}
