import type { MessageReply } from "../../../../lib/messages.ts"
import { setTimeout as delay } from "node:timers/promises"
import { loadGlobalConfig } from "../../core/config/global.js"
import { formatLocalIso } from "../../core/time.js"
import { TuneWeaveService } from "../tuneweave/service.ts"
import { NeteasePartnerTask, type PartnerConfig, type PartnerReport } from "./partner-task.ts"

type Global = Awaited<ReturnType<typeof loadGlobalConfig>>
type ScheduleResult = PartnerReport | { skipped: true; reason: string }

interface MediaRuntime {
  readonly disconnect?: AbortSignal
  whenReady(start: () => void): () => void
  registerTask(cron: string, run: () => Promise<unknown>): () => Promise<void>
  notifyMasters?(reply: MessageReply, signal?: AbortSignal): Promise<void>
}

interface ScheduleOptions {
  execute(config: Global, trigger: string, options: { signal: AbortSignal; once: true }): Promise<ScheduleResult>
  render(title: string, report: PartnerReport): Promise<{ image?: Uint8Array; text: string }>
  load?: () => Promise<Global>
  now?: () => Date
  hasRunToday?: () => Promise<boolean>
  ensureReady?: (config: Global, signal: AbortSignal) => Promise<unknown>
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

const defaultSchedule = "0 5 0 * * ? *"

export function partnerCron(value: unknown) {
  if (value == null || value === "") value = defaultSchedule
  if (typeof value !== "string") throw new Error("合伙人定时配置须为 cron 表达式")
  const fields = value.trim().split(/\s+/u)
  if (fields.length === 7 && fields[6] === "*") fields.pop()
  if (fields.length === 5) fields.unshift("0")
  if (fields.length !== 6) throw new Error("合伙人定时配置需要五段或六段 cron 表达式")
  for (const index of [3,5]) if (fields[index] === "?") fields[index] = "*"
  return fields.join(" ")
}

function pastPartnerSlot(config: PartnerConfig | undefined, now: Date) {
  if (config?.enable !== true || config.auto_catch_up !== true) return false
  const match = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \* \*$/u.exec(partnerCron(config.schedule))
  if (!match) return false
  const [seconds, minutes, hours] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (seconds >= 60 || minutes >= 60 || hours >= 24) return false
  const slot = new Date(now)
  slot.setHours(hours, minutes, seconds, 0)
  return now > slot
}

export async function createPartnerSchedule({ mediaRuntime, signal }: { mediaRuntime?: MediaRuntime; signal?: AbortSignal }, {
  execute, render, load = loadGlobalConfig, now = () => new Date(),
  hasRunToday = () => new NeteasePartnerTask().hasRunToday(),
  ensureReady = (config, active) => new TuneWeaveService({ config:config.tuneweave }).requireReady("netease", active),
  wait = (ms, active) => delay(ms, undefined, { signal:active, ref:false }),
}: ScheduleOptions) {
  if (!mediaRuntime || signal?.aborted || mediaRuntime.disconnect?.aborted) return
  const controller = new AbortController()
  const active = AbortSignal.any([controller.signal, signal, mediaRuntime.disconnect].filter((value): value is AbortSignal => Boolean(value)))
  let unregister: (() => Promise<void>) | undefined
  let cancelReady: (() => void) | undefined
  let pending: Promise<ScheduleResult | void> | undefined
  let startup: Promise<void> | undefined
  let ready = false
  const logFailure = () => {
    if (!active.aborted) console.warn("[media] 合伙人自动任务未完成，请检查 TuneWeave 状态和最近日志。")
  }

  function run(trigger: string, startupDay?: string) {
    if (!ready || active.aborted || pending) return pending
    pending = (async () => {
      const config = await load()
      const partner = config.netease_partner as PartnerConfig | undefined
      if (active.aborted || partner?.enable !== true) return
      if (startupDay && (startupDay !== formatLocalIso(now()).slice(0,10) ||
        !pastPartnerSlot(partner, now()))) return
      if (await hasRunToday() || active.aborted) return
      if (startupDay) await ensureReady(config, active)
      if (active.aborted) return
      const report = await execute(config, trigger, { signal:active, once:true })
      if (active.aborted || "skipped" in report || partner.notify_master === false || !mediaRuntime?.notifyMasters) return report
      const { image, text } = await render("合伙人自动任务", report)
      if (!active.aborted) await mediaRuntime.notifyMasters(image ? { type:"image", file:image } : text, active)
      return report
    })().catch(logFailure).finally(() => { pending = undefined })
    return pending
  }

  try {
    const config = await load()
    if (active.aborted) return
    unregister = mediaRuntime.registerTask(partnerCron((config.netease_partner as PartnerConfig | undefined)?.schedule), async () => run("自动任务"))
    cancelReady = mediaRuntime.whenReady(() => {
      if (active.aborted) return
      ready = true
      startup = (async () => {
        const current = await load()
        const currentTime = now()
        if (active.aborted || !pastPartnerSlot(current.netease_partner as PartnerConfig | undefined, currentTime) || await hasRunToday()) return
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
