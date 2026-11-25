import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import type { MessageReply } from "../../../../lib/messages.ts"
import { setTimeout as delay } from "node:timers/promises"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { formatLocalIso } from "../../core/time.ts"
import { TuneWeaveService } from "../tuneweave/service.ts"
import type { FirstMaintenanceResult } from "../tuneweave/startup.ts"
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
  waitForMaintenance?: (signal: AbortSignal) => Promise<FirstMaintenanceResult>
  ensureReady?: (config: Global, signal: AbortSignal) => Promise<unknown>
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

const defaultSchedule = "0 30 1 * * ? *"

export function partnerCron(value: unknown) {
  if (value == null || value === "") value = defaultSchedule
  if (typeof value !== "string") throw new Error($t("services.music.partner-schedule.text_02711f2ad9"))
  const fields = value.trim().split(/\s+/u)
  if (fields.length === 7 && fields[6] === "*") fields.pop()
  if (fields.length === 5) fields.unshift("0")
  if (fields.length !== 6) throw new Error($t("services.music.partner-schedule.text_7c4f81000e"))
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
  waitForMaintenance,
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
    if (!active.aborted) console.warn($t("services.music.partner-schedule.text_9c2208b8ea"))
  }

  function run(trigger: string, startupDay?: string) {
    if (!ready || active.aborted || pending) return pending
    pending = (async () => {
      const config = await load()
      const partner = config.netease_partner as PartnerConfig | undefined
      if (active.aborted || partner?.enable !== true) return
      if (startupDay && (startupDay !== formatLocalIso(now()).slice(0,10) ||
        !pastPartnerSlot(partner, now()))) return
      let report: ScheduleResult
      try {
        if (await hasRunToday() || active.aborted) return
        if (startupDay) {
          const serviceReady = await ensureReady(config, active).then(() => true, () => false)
          if (!serviceReady) { logFailure(); return }
        }
        if (active.aborted) return
        report = await execute(config, trigger, { signal:active, once:true })
      } catch {
        if (active.aborted) return
        logFailure()
        report = { trigger, time:formatLocalIso(now()), accounts:[{
          nickname:$t("services.music.partner-schedule.text_87ca0837b6"), total:0, success:0, skip:0, fail:1, attempts:0,
          details:[$t("services.music.partner-schedule.text_45bd1eade3")], evaluations:[],
        }] }
      }
      if (active.aborted || "skipped" in report || partner.notify_master === false || !mediaRuntime?.notifyMasters) return report
      const { image, text } = await render($t("services.music.partner-schedule.text_c5b385a3e1"), report)
      if (!active.aborted) await mediaRuntime.notifyMasters(image ? { type:"image", file:image } : text, active)
      return report
    })().catch(logFailure).finally(() => { pending = undefined })
    return pending
  }

  try {
    const config = await load()
    if (active.aborted) return
    unregister = mediaRuntime.registerTask(partnerCron((config.netease_partner as PartnerConfig | undefined)?.schedule), async () => run($t("services.music.partner-schedule.text_44dc0ac37a")))
    cancelReady = mediaRuntime.whenReady(() => {
      if (active.aborted || ready) return
      ready = true
      startup = (async () => {
        const current = await load()
        const currentTime = now()
        if (active.aborted || !pastPartnerSlot(current.netease_partner as PartnerConfig | undefined, currentTime) || await hasRunToday()) return
        await wait(60000, active)
        if (active.aborted) return
        const maintenance = await waitForMaintenance?.(active)
        if (active.aborted || maintenance === "cancelled") return
        if (maintenance === "failed") {
          console.warn($t("services.music.partner-schedule.text_cec2b7d252"))
          return
        }
        await run($t("services.music.partner-schedule.text_3b5cc424ca"), formatLocalIso(currentTime).slice(0,10))
      })().catch(logFailure)
    })
  } catch {
    await unregister?.()
    if (!active.aborted) console.warn($t("services.music.partner-schedule.text_d8a34bb5ae"))
    return
  }

  return async () => {
    controller.abort()
    cancelReady?.()
    await Promise.allSettled([unregister?.(), pending, startup])
  }
}
