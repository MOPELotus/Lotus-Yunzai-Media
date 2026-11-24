import { runInitializationStage } from "../../../../lib/initialization-progress.ts"
import { setTimeout as delay } from "node:timers/promises"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { ToolInstallerService, type ToolsConfig } from "../tools/installer.ts"
import { TuneWeaveService, type TuneWeaveConfig } from "./service.ts"

interface StartupServices {
  mediaRuntime?: {
    readonly disconnect: AbortSignal
    whenReady(start: () => void): () => void
    notifyMasters?(reply: string, signal?: AbortSignal): Promise<void>
  }
  signal?: AbortSignal
}

interface StartupConfig {
  tools?: ToolsConfig
  tuneweave?: Partial<TuneWeaveConfig> & { update_delay_ms?: unknown }
}

interface MaintenanceItem {
  name: string
  ok: boolean
  changed?: boolean
  updateDeferred?: boolean
}

type StartupTune = Pick<TuneWeaveService, "localUrl" | "resume" | "status">

interface StartupHooks {
  load?: () => Promise<StartupConfig>
  createTune?: (config: StartupConfig["tuneweave"]) => StartupTune
  prepareTools?: (config: ToolsConfig | undefined, signal: AbortSignal) => Promise<Awaited<ReturnType<ToolInstallerService["ensureAll"]>>>
  wait?: (ms: number, signal: AbortSignal) => Promise<unknown>
}

export type FirstMaintenanceResult = "ready" | "failed" | "cancelled"

const initialDelay = 0
const retryDelay = 300_000
const maxAttempts = 3

function startupDelay(value: unknown) {
  const ms = typeof value === "string" && value.trim() ? Number(value) : value
  return typeof ms === "number" && Number.isInteger(ms) && ms > 0 && ms <= 2_147_483_647 ? ms : initialDelay
}

function isLocal(tune: Pick<TuneWeaveService, "localUrl">) {
  try { tune.localUrl(); return true } catch { return false }
}

export function startMediaMaintenance({ mediaRuntime, signal }: StartupServices, {
  load = loadGlobalConfig,
  createTune = config => new TuneWeaveService({ config }),
  prepareTools = (config, active) => runInitializationStage("检查已有 FFmpeg", onTaskProgress => new ToolInstallerService({ config }).checkAll({ signal: active, onTaskProgress }), { label: "媒体维护", signal: active }),
  wait = (ms, active) => delay(ms, undefined, { signal: active, ref: false }),
}: StartupHooks = {}) {
  if (!mediaRuntime) return
  const controller = new AbortController()
  const active = AbortSignal.any([controller.signal, signal, mediaRuntime.disconnect].filter((value): value is AbortSignal => Boolean(value)))
  const firstRound = Promise.withResolvers<"ready" | "failed">()
  let startup: Promise<void> | undefined
  const notify = async (message: string) => {
    if (!active.aborted) {
      try { await mediaRuntime.notifyMasters?.(message, active) } catch {}
    }
  }

  async function prepare(config: StartupConfig, tune: StartupTune, local: boolean) {
    const items: MaintenanceItem[] = []
    active.throwIfAborted()
    try {
      const tools = await prepareTools(config.tools, active)
      for (const item of tools.items) {
        items.push({ name: item.name, ok: item.ok, changed: item.ok && item.status === "installed", updateDeferred: item.ok && item.updateDeferred })
      }
    } catch {
      items.push({ name: "ffmpeg", ok: false })
    }

    active.throwIfAborted()
    if (local) {
      try {
        const item = await runInitializationStage("检查已有 TuneWeave", () => tune.status("netease", active, "error"), { label: "媒体维护", signal: active })
        items.push({ name: "TuneWeave", ok: item.ok,
          changed: false, updateDeferred: false })
      } catch {
        items.push({ name: "TuneWeave", ok: false })
      }
    }
    active.throwIfAborted()
    return items
  }

  const cancel = mediaRuntime.whenReady(() => {
    if (active.aborted || startup) return
    startup = (async () => {
      const config = await load()
      active.throwIfAborted()
      const tune = createTune(config.tuneweave)
      const local = isLocal(tune)
      if (local) {
        try { await runInitializationStage("恢复本机 TuneWeave", () => tune.resume(active), { label: "媒体维护", signal: active }) } catch {
          active.throwIfAborted()
          console.warn("[media] 本机 TuneWeave 未恢复，将继续开机环境维护。")
          await notify("本机 TuneWeave 恢复失败，将继续开机环境维护。")
        }
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await wait(attempt === 1 ? startupDelay(config.tuneweave?.update_delay_ms) : retryDelay, active)
        const items = await prepare(config, tune, local)
        const failed = items.filter(item => !item.ok).map(item => item.name)
        if (attempt === 1) firstRound.resolve(failed.length ? "failed" : "ready")
        const changed = items.filter(item => item.changed).map(item => item.name)
        const deferred = items.filter(item => item.updateDeferred).map(item => item.name)
        if (failed.length) await notify("媒体开机环境尚未就绪：" + failed.join("、") + "。请运行 bun run bootstrap 补齐。")
        else if (changed.length) await notify("媒体开机环境更新完成：" + changed.join("、") + "，已通过就绪检查。")
        if (deferred.length) console.warn("[media] 现有环境可用，更新暂未完成：" + deferred.join("、"))
        if (!failed.length && !deferred.length) return
      }
    })().catch(() => {
      if (!active.aborted) {
        firstRound.resolve("failed")
        console.warn("[media] 开机环境维护未完成，请检查媒体配置或发送 #初始化环境。")
      }
    })
  })
  return {
    async waitForFirstRound(signal: AbortSignal): Promise<FirstMaintenanceResult> {
      const waiting = AbortSignal.any([active, signal])
      if (waiting.aborted) return "cancelled"
      const cancelled = Promise.withResolvers<"cancelled">()
      const onAbort = () => cancelled.resolve("cancelled")
      waiting.addEventListener("abort", onAbort, { once: true })
      try { return await Promise.race([firstRound.promise, cancelled.promise]) }
      finally { waiting.removeEventListener("abort", onAbort) }
    },
    async dispose() {
      controller.abort()
      cancel()
      await startup
    },
  }
}
