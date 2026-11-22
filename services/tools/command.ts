import type { MessageFallback } from "../../../../lib/commands.ts"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderStatusCard } from "../../core/render/service.ts"
import { TuneWeaveService } from "../tuneweave/service.ts"
import { ToolInstallerService } from "./installer.ts"

function matches(message: string) {
  return message === "#初始化环境" || message === "#初始化工具环境" || message === "#初始化签到环境"
}

export function createMediaEnvironment({ signal }: { readonly signal?: AbortSignal }) {
  const fallback: MessageFallback = async (message, context) => {
    if (!matches(message) || signal?.aborted) return
    if (context.isDelegated || context.canManagePackages !== true) {
      return "[media] 只有机器人主人可以初始化媒体环境。"
    }
    const config = await loadGlobalConfig()
    // The host capability confirms the current owner on either protocol.
    if (!new PermissionService({ permissions: config.permissions }).explain({ ...context, isMaster: true }, "tools.install").ok) {
      return "[media] 当前会话没有初始化工具链的权限。"
    }
    if (signal?.aborted) return []
    const ready = await new ToolInstallerService({ config: config.tools }).ensureAll()
    const items = ready.items.map<{ label: string; value: string }>(item => ({
      label: item.name,
      value: item.ok ? item.status : item.reason || "检查失败",
    }))
    if (signal?.aborted) return []
    try {
      const tune = await new TuneWeaveService({ config: config.tuneweave }).initialize()
      items.push({ label: "TuneWeave", value: tune.ok ? tune.version || "可用" : tune.message || "检查失败" })
    } catch (error) {
      items.push({ label: "TuneWeave", value: error instanceof Error ? error.message : "检查失败" })
    }
    if (signal?.aborted) return []
    const summary = items.map(item => item.label + "：" + item.value).join("\n")
    const image = await renderStatusCard({ title: "媒体环境", items }).catch(() => undefined)
    if (signal?.aborted) return []
    if (image && await context.reply({ type: "image", file: image })) return []
    return summary
  }
  return { matches, fallback }
}
