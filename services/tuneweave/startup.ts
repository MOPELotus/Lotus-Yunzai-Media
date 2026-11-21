import { loadGlobalConfig } from "../../core/config/global.ts"
import { TuneWeaveService, type TuneWeaveConfig } from "./service.ts"

interface StartupServices {
  mediaRuntime?: {
    readonly disconnect: AbortSignal
    whenReady(start: () => void): () => void
  }
  signal?: AbortSignal
}

interface StartupConfig {
  tuneweave?: Partial<TuneWeaveConfig>
}

interface StartupHooks {
  load?: () => Promise<StartupConfig>
  resume?: (config: StartupConfig, active: AbortSignal) => Promise<unknown>
}

export function resumeTuneWeaveOnStart({ mediaRuntime, signal }: StartupServices, {
  load = loadGlobalConfig,
  resume = (config, active) => new TuneWeaveService({ config:config.tuneweave }).resume(active),
}: StartupHooks = {}) {
  if (!mediaRuntime) return
  const controller = new AbortController()
  const active = AbortSignal.any([controller.signal, signal, mediaRuntime.disconnect].filter((value): value is AbortSignal => Boolean(value)))
  let startup: Promise<void> | undefined
  const cancel = mediaRuntime.whenReady(() => {
    if (active.aborted) return
    startup = (async () => {
      const config = await load()
      if (!active.aborted) await resume(config, active)
    })().catch(() => {
      if (!active.aborted) console.warn("[media] 本机 TuneWeave 未恢复，请检查状态或发送 #初始化环境。")
    })
  })
  return async () => {
    controller.abort()
    cancel()
    await startup
  }
}
