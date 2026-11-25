import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
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
  prepareTools = (config, active) => runInitializationStage($t("services.tuneweave.startup.text_7781ba1349"), onTaskProgress => new ToolInstallerService({ config }).checkAll({ signal: active, onTaskProgress }), { label: $t("services.tuneweave.startup.text_5522303635"), signal: active }),
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
        const item = await runInitializationStage($t("services.tuneweave.startup.text_59cec365f9"), () => tune.status("netease", active, "error"), { label: $t("services.tuneweave.startup.text_5522303635"), signal: active })
        items.push({ name: "TuneWeave", ok: item.ok && !item.requiresUpdate,
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
        try { await runInitializationStage($t("services.tuneweave.startup.text_4c24112568"), () => tune.resume(active), { label: $t("services.tuneweave.startup.text_5522303635"), signal: active }) } catch {
          active.throwIfAborted()
          console.warn($t("services.tuneweave.startup.text_cabf735036"))
          await notify($t("services.tuneweave.startup.text_0cb39aeef2"))
        }
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await wait(attempt === 1 ? startupDelay(config.tuneweave?.update_delay_ms) : retryDelay, active)
        const items = await prepare(config, tune, local)
        const failed = items.filter(item => !item.ok).map(item => item.name)
        if (attempt === 1) firstRound.resolve(failed.length ? "failed" : "ready")
        const changed = items.filter(item => item.changed).map(item => item.name)
        const deferred = items.filter(item => item.updateDeferred).map(item => item.name)
        if (failed.length) await notify($t("services.tuneweave.startup.text_cca2c5ce0c") + failed.join("、") + $t("services.tuneweave.startup.text_b348d66a77"))
        else if (changed.length) await notify($t("services.tuneweave.startup.text_4e60d24081") + changed.join("、") + $t("services.tuneweave.startup.text_0c5b0fd746"))
        if (deferred.length) console.warn($t("services.tuneweave.startup.text_72f8fb4d14") + deferred.join("、"))
        if (!failed.length && !deferred.length) return
      }
    })().catch(() => {
      if (!active.aborted) {
        firstRound.resolve("failed")
        console.warn($t("services.tuneweave.startup.text_2d16e4b506"))
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
