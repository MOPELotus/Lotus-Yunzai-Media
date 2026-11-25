import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
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
    runInitializationStage($t("services.tools.command.text_2ceff2a7b1"), onTaskProgress => new ToolInstallerService({ config }).ensureAll({ signal, onProgress, onTaskProgress }), { label: $t("services.tools.command.text_eb81cd9629"), signal }),
  prepareTuneWeave: (config: Config["tuneweave"], onProgress: Progress, signal?: AbortSignal) =>
    runInitializationStage($t("services.tools.command.text_9a616f5846"), onTaskProgress => new TuneWeaveService({ config }).initialize({ signal, onProgress, onTaskProgress }), { label: $t("services.tools.command.text_eb81cd9629"), signal }),
  render: renderStatusCard,
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : $t("services.tools.command.text_4f6f06254d")
}

type Preparation = Omit<typeof mediaPreparation, "prepareCaptcha"> & {
  prepareCaptcha?: typeof mediaPreparation.prepareCaptcha
}

export function createMediaEnvironment({ signal }: { readonly signal?: AbortSignal }, preparation: Preparation = mediaPreparation) {
  const fallback: MessageFallback = async (message, context) => {
    if (!matches(message) || signal?.aborted) return
    if (context.isDelegated || context.canManagePackages !== true) {
      return $t("services.tools.command.text_543869fe6f")
    }
    const config = await preparation.loadConfig()
    // The host capability confirms the current owner on either protocol.
    if (!new PermissionService({ permissions: config.permissions }).explain({ ...context, isMaster: true }, "tools.install").ok) {
      return $t("services.tools.command.text_f798651ccf")
    }
    if (signal?.aborted) return []
    const progress: Progress = async (text) => {
      if (signal?.aborted) return
      try { await context.reply(`${text}`) } catch { /* A progress reply is best effort. */ }
    }
    await progress($t("services.tools.command.text_729314a54a"))
    if (signal?.aborted) return []

    const items: { label: string; value: string; ok: boolean }[] = []
    try {
      const ready = await preparation.prepareTools(config.tools, progress, signal)
      for (const item of ready.items) {
        const label = item.name === "ffmpeg" ? "FFmpeg" : item.name
        const value = item.ok
          ? item.reason || (item.status === "installed" ? $t("services.tools.command.text_a8b6c39dca") : $t("services.tools.command.text_4d99c976be"))
          : $t("services.tools.command.text_766394516d", { "reason": item.reason })
        items.push({ label, value, ok: item.ok })
        await progress(`${label}：${value}`)
      }
    } catch (error) {
      const value = $t("services.tools.command.text_854c7b55b8", { "value1": failureMessage(error) })
      items.push({ label: "FFmpeg", value, ok: false })
      await progress(`FFmpeg：${value}`)
    }
    if (signal?.aborted) return []
    await progress($t("services.tools.command.text_bca8be9345"))
    if (signal?.aborted) return []
    let tuneResult: { value: string; ok: boolean }
    try {
      const tune = await preparation.prepareTuneWeave(config.tuneweave, progress, signal)
      const deferred = "updateDeferred" in tune && tune.updateDeferred ? tune.message : ""
      const value = tune.ok ? [tune.version || $t("services.tools.command.text_4d99c976be"), deferred].filter(Boolean).join(" · ") : $t("services.tools.command.text_854c7b55b8", { "value1": tune.message || $t("services.tools.command.text_4f6f06254d") })
      tuneResult = { value, ok: tune.ok }
    } catch (error) {
      tuneResult = { value: $t("services.tools.command.text_854c7b55b8", { "value1": failureMessage(error) }), ok: false }
    }
    if (signal?.aborted) return []
    items.push({ label: "TuneWeave", ...tuneResult })
    await progress(`TuneWeave：${tuneResult.value}`)
    if (signal?.aborted) return []

    let captchaFailure: string | undefined
    if (preparation.prepareCaptcha) {
      await progress($t("services.tools.command.text_b5d298a054"))
      if (signal?.aborted) return []
      try {
        await preparation.prepareCaptcha(signal)
        await progress($t("services.tools.command.text_44fdfbe03d"))
      } catch {
        if (signal?.aborted) return []
        captchaFailure = $t("services.tools.command.text_2ea91263d6")
      }
      if (signal?.aborted) return []
    }

    const status = items.every(item => item.ok) ? $t("services.tools.command.text_67ec0b1853") : $t("services.tools.command.text_79ce4c8efe")
    const rows = items.map(({ label, value }) => ({ label, value }))
    const summary = [$t("services.tools.command.text_133cbd1439") + status, ...rows.map(item => item.label + "：" + item.value)].join("\n")
    const image = await preparation.render({ title: $t("services.tools.command.text_22eeda2814"), subtitle: status, items: rows }).catch(() => undefined)
    if (signal?.aborted) return []
    if (image && await context.reply({ type: "image", file: image })) return captchaFailure ?? []
    return [summary, captchaFailure].filter(Boolean).join("\n")
  }
  return { matches, fallback }
}
