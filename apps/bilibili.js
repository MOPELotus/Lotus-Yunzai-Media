import { canManagePackages } from "../../../lib/command-permissions.ts"
import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { loadGlobalConfig } from "../core/config/global.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { BilibiliService } from "../services/bilibili/service.js"
import { ToolInstallerService } from "../services/tools/installer.js"

const BasePlugin = globalThis.plugin

export class BilibiliMedia extends BasePlugin {
  constructor() {
    super({
      name: "[media] B 站解析",
      dsc: "媒体工具初始化",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [{ reg: "^#初始化环境$", fnc: "initializeMediaTools" }],
    })
  }

  async initializeMediaTools() {
    if (!canManagePackages(this.e)) {
      await replyText(this, "[media] 只有机器人主人可以初始化媒体环境。")
      return true
    }
    const config = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: config.permissions }).explain(this.e, "tools.install")
    if (!permission.ok) {
      await replyText(this, "[media] 当前会话没有初始化工具链的权限。")
      return true
    }
    const ready = await new ToolInstallerService({ config: config.tools }).ensureAll()
    try {
      const tune = await new BilibiliService({ tuneweaveConfig: config.tuneweave }).tuneweave.initialize()
      ready.items.push({ name: "TuneWeave", ok: tune.ok, status: tune.version, reason: tune.message })
    } catch (error) {
      ready.items.push({ name: "TuneWeave", ok: false, reason: error.message })
    }
    const items = ready.items.map(item => ({ label: item.name, value: item.ok ? item.status || "可用" : item.reason || "检查失败" }))
    const fallback = items.map(item => `${item.label}：${item.value}`).join("\n")
    const image = await renderStatusCard({ title: "媒体环境", items }).catch(() => undefined)
    await replyImage(this, image, fallback)
    return true
  }
}
