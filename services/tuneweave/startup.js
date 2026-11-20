import { loadGlobalConfig } from "../../core/config/global.js"
import { TuneWeaveService } from "./service.js"

export function resumeTuneWeaveOnStart({ mediaRuntime, signal }, {
  load = loadGlobalConfig,
  resume = (config, active) => new TuneWeaveService({ config:config.tuneweave }).resume(active),
} = {}) {
  if (!mediaRuntime) return
  const controller = new AbortController()
  const active = AbortSignal.any([controller.signal, signal, mediaRuntime.disconnect].filter(Boolean))
  let startup
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
