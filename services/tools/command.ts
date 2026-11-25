import { runInitializationStage } from "../../../../lib/initialization-progress.ts"
import type { MessageFallback } from "../../../../lib/commands.ts"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderStatusCard } from "../../core/render/service.ts"
import { TuneWeaveService } from "../tuneweave/service.ts"
import { ToolInstallerService } from "./installer.ts"

function matches(message: string) {
  return message === "#初始化环境" || message === "#初始化工具环境" || message === "#初始化签到环境"
}

type Config = Awaited<ReturnType<typeof loadGlobalConfig>>
type Progress = (message: string) => Promise<void>

const mediaPreparation = {
  loadConfig: loadGlobalConfig,
  async prepareCaptcha(signal?: AbortSignal) {
    const { initializeCaptchaModels } = await import("../../../../lib/captcha/initialize.ts")
    await initializeCaptchaModels(new URL("../../../../", import.meta.url), signal ?? new AbortController().signal)
  },
  prepareTools: (config: Config["tools"], onProgress: Progress, signal?: AbortSignal) =>
    runInitializationStage("检查与准备 FFmpeg", onTaskProgress => new ToolInstallerService({ config }).ensureAll({ signal, onProgress, onTaskProgress }), { label: "媒体初始化", signal }),
  prepareTuneWeave: (config: Config["tuneweave"], onProgress: Progress, signal?: AbortSignal) =>
    runInitializationStage("检查与准备 TuneWeave", onTaskProgress => new TuneWeaveService({ config }).initialize({ signal, onProgress, onTaskProgress }), { label: "媒体初始化", signal }),
  render: renderStatusCard,
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : "检查失败"
}

type Preparation = Omit<typeof mediaPreparation, "prepareCaptcha"> & {
  prepareCaptcha?: typeof mediaPreparation.prepareCaptcha
}

export function createMediaEnvironment({ signal }: { readonly signal?: AbortSignal }, preparation: Preparation = mediaPreparation) {
  const fallback: MessageFallback = async (message, context) => {
    if (!matches(message) || signal?.aborted) return
    if (context.isDelegated || context.canManagePackages !== true) {
      return "只有机器人主人可以初始化媒体环境。"
    }
    const config = await preparation.loadConfig()
    // The host capability confirms the current owner on either protocol.
    if (!new PermissionService({ permissions: config.permissions }).explain({ ...context, isMaster: true }, "tools.install").ok) {
      return "当前会话没有初始化工具链的权限。"
    }
    if (signal?.aborted) return []
    const progress: Progress = async (text) => {
      if (signal?.aborted) return
      try { await context.reply(`${text}`) } catch { /* A progress reply is best effort. */ }
    }
    await progress("正在检查媒体环境，补齐缺失组件并检查更新。")
    if (signal?.aborted) return []

    const items: { label: string; value: string; ok: boolean }[] = []
    try {
      const ready = await preparation.prepareTools(config.tools, progress, signal)
      for (const item of ready.items) {
        const label = item.name === "ffmpeg" ? "FFmpeg" : item.name
        const value = item.ok
          ? item.reason || (item.status === "installed" ? "已安装" : "可用")
          : `失败：${item.reason}`
        items.push({ label, value, ok: item.ok })
        await progress(`${label}：${value}`)
      }
    } catch (error) {
      const value = `失败：${failureMessage(error)}`
      items.push({ label: "FFmpeg", value, ok: false })
      await progress(`FFmpeg：${value}`)
    }
    if (signal?.aborted) return []
    await progress("正在检查 TuneWeave 服务。")
    if (signal?.aborted) return []
    let tuneResult: { value: string; ok: boolean }
    try {
      const tune = await preparation.prepareTuneWeave(config.tuneweave, progress, signal)
      const deferred = "updateDeferred" in tune && tune.updateDeferred ? tune.message : ""
      const value = tune.ok ? [tune.version || "可用", deferred].filter(Boolean).join(" · ") : `失败：${tune.message || "检查失败"}`
      tuneResult = { value, ok: tune.ok }
    } catch (error) {
      tuneResult = { value: `失败：${failureMessage(error)}`, ok: false }
    }
    if (signal?.aborted) return []
    items.push({ label: "TuneWeave", ...tuneResult })
    await progress(`TuneWeave：${tuneResult.value}`)
    if (signal?.aborted) return []

    let captchaFailure: string | undefined
    if (preparation.prepareCaptcha) {
      await progress("正在准备验证码模型，下载并校验缺失文件。")
      if (signal?.aborted) return []
      try {
        await preparation.prepareCaptcha(signal)
        await progress("验证码模型：已准备完成。")
      } catch {
        if (signal?.aborted) return []
        captchaFailure = "验证码模型准备失败，请重新发送初始化指令重试。"
      }
      if (signal?.aborted) return []
    }

    const status = items.every(item => item.ok) ? "检查完成" : "存在失败"
    const rows = items.map(({ label, value }) => ({ label, value }))
    const summary = ["媒体环境 · " + status, ...rows.map(item => item.label + "：" + item.value)].join("\n")
    const image = await preparation.render({ title: "媒体环境", subtitle: status, items: rows }).catch(() => undefined)
    if (signal?.aborted) return []
    if (image && await context.reply({ type: "image", file: image })) return captchaFailure ?? []
    return [summary, captchaFailure].filter(Boolean).join("\n")
  }
  return { matches, fallback }
}
