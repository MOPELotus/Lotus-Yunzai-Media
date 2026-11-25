import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import { lockFile } from "../../../../lib/file-lock.ts"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { dataPath } from "../../core/path.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderStatusCard, renderTemplate } from "../../core/render/service.ts"
import { createSubscriptionConfig } from "../subscriptions/config.ts"
import { biliSharedSession } from "../subscriptions/bilibili/shared.ts"
import { BilibiliService } from "./service.ts"

const command = "#B站登录"
const switchCommand = "#B站换号"
const settings = createSubscriptionConfig(dataPath, lockFile)

async function loginError(context: MessageFallbackContext, message: string) {
  const png = await renderStatusCard({
    title: $t("services.bilibili.login-command.text_9158dcf753"), subtitle: $t("services.bilibili.login-command.text_7f5440b5cf"), badge: $t("services.bilibili.login-command.text_28384d7afd"), message, userId: context.user_id,
    items: [{ label: $t("services.bilibili.login-command.text_abee497473"), value: $t("services.bilibili.login-command.text_97b575de6d") }],
  }, { saveId: `media-bilibili-error-${context.user_id || "user"}` }).catch(() => undefined)
  return png ? { type: "image" as const, file: png } : message
}

export function createBilibiliLogin({ signal }: { readonly signal?: AbortSignal }) {
  let signingIn = false
  const matches = (message: string) => message === command || message === switchCommand
  const fallback: MessageFallback = async (message, context) => {
    if (!matches(message)) return
    const friend = context.privateCredentialSignal
    if (context.isDelegated || context.message_type !== "private" || !friend || context.user_id === undefined ||
        !context.isBotMaster(context.user_id)) {
      return loginError(context, $t("services.bilibili.login-command.text_4f1c3406e6"))
    }
    const active = signal ? AbortSignal.any([signal, friend]) : friend
    let acquired = false
    try {
      active.throwIfAborted()
      const config = await loadGlobalConfig()
      if (!new PermissionService({ permissions: config.permissions }).explain({ ...context, isMaster: true }, "bilibili.login").ok) {
        return loginError(context, $t("services.bilibili.login-command.text_6a4abb3e70"))
      }
      if (signingIn) return $t("services.bilibili.login-command.text_559a364c22")
      signingIn = acquired = true
      const service = new BilibiliService({ tuneweaveConfig: config.tuneweave })
      const shared = biliSharedSession({ createService: async () => service,
        enabled: async () => (await settings.settings("bilibili")).sharedBiliLogin })
      if (message === command && await service.hasReusableLogin(active)) {
        return $t("services.bilibili.login-command.text_102f4a7659")
      }
      const allowsSharing = await shared.available(active)
      active.throwIfAborted()
      const qr = await service.createQrLogin({ signal: active })
      const image = await renderTemplate("qr-login", {
        title: $t("services.bilibili.login-command.text_9158dcf753"),
        subtitle: $t("services.bilibili.login-command.text_7f5440b5cf"),
        badge: "3 MIN",
        notice: allowsSharing ? $t("services.bilibili.login-command.text_6d827611e7") :
          $t("services.bilibili.login-command.text_8fd3c7b241"),
        qrDataUrl: qr.qrDataUrl,
        profileId: "bilibili",
      }, {
        saveId: `media-bilibili-login-${context.user_id || "master"}`,
      }).catch(() => undefined)
      active.throwIfAborted()
      const link = typeof qr.url === "string" && URL.parse(qr.url)
      const prompt = image ? { type: "image" as const, file: image } :
        link && link.origin === "https://passport.bilibili.com" && !link.username && !link.password && !link.hash
          ? $t("services.bilibili.login-command.text_178a17312a") + link.href : undefined
      if (!prompt) return $t("services.bilibili.login-command.text_c8674a0f5b")
      let delivered = false
      await context.reply(prompt, false, { onDelivered: () => { delivered = true } })
      if (!delivered) return $t("services.bilibili.login-command.text_22a38f0a99")
      active.throwIfAborted()
      const result = await service.waitQrLogin({ qrcodeKey: qr.qrcodeKey, signal: active })
      const report = await renderStatusCard({
        title: $t("services.bilibili.login-command.text_9158dcf753"),
        subtitle: $t("services.bilibili.login-command.text_7f5440b5cf"),
        badge: $t("services.bilibili.login-command.text_c0b3fbff51"),
        message: allowsSharing ? $t("services.bilibili.login-command.text_4e2593785b") :
          $t("services.bilibili.login-command.text_7e1611ac7a"),
        userId: context.user_id,
        items: [
          { label: $t("services.bilibili.login-command.text_a488e93d69"), value: result.account.source },
          { label: $t("services.bilibili.login-command.text_f0f609f1e2"), value: result.account.saved_at },
        ],
      }, { saveId: `media-bilibili-login-ok-${context.user_id || "master"}` }).catch(() => undefined)
      active.throwIfAborted()
      return report ? { type: "image", file: report } : $t("services.bilibili.login-command.text_e294f47a39")
    } catch (error) {
      if (active.aborted) return []
      return loginError(context, error instanceof Error ? error.message : $t("services.bilibili.login-command.text_0c4d715a29"))
    } finally {
      if (acquired) signingIn = false
    }
  }
  return { matches, fallback }
}
