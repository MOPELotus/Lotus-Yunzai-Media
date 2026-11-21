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
const settings = createSubscriptionConfig(dataPath, lockFile)

async function loginError(context: MessageFallbackContext, message: string) {
  const png = await renderStatusCard({
    title: "B站登录", subtitle: "Lotus-Yunzai · B 站", badge: "失败", message, userId: context.user_id,
    items: [{ label: "建议", value: "检查链接是否有效，或稍后重试。" }],
  }, { saveId: `media-bilibili-error-${context.user_id || "user"}` }).catch(() => undefined)
  return png ? { type: "image" as const, file: png } : "[media] " + message
}

export function createBilibiliLogin({ signal }: { readonly signal?: AbortSignal }) {
  let signingIn = false
  const fallback: MessageFallback = async (message, context) => {
    if (message !== command) return
    const friend = context.privateCredentialSignal
    if (context.isDelegated || context.message_type !== "private" || !friend || context.user_id === undefined ||
        !context.isBotMaster(context.user_id)) {
      return loginError(context, "请由机器人主人在已连接的好友私聊登录 B 站账号。")
    }
    const active = signal ? AbortSignal.any([signal, friend]) : friend
    let acquired = false
    try {
      active.throwIfAborted()
      const config = await loadGlobalConfig()
      if (!new PermissionService({ permissions: config.permissions }).explain({ ...context, isMaster: true }, "bilibili.login").ok) {
        return loginError(context, "没有 B 站登录权限。")
      }
      if (signingIn) return "已有 B 站登录正在进行，请稍后重试。"
      signingIn = acquired = true
      const service = new BilibiliService({ tuneweaveConfig: config.tuneweave })
      const shared = biliSharedSession({ createService: async () => service,
        enabled: async () => (await settings.settings("bilibili")).sharedBiliLogin })
      const allowsSharing = await shared.available(active)
      active.throwIfAborted()
      const qr = await service.createQrLogin({ signal: active })
      const image = await renderTemplate("qr-login", {
        title: "B站登录",
        subtitle: "Lotus-Yunzai · B 站",
        badge: "3 MIN",
        notice: allowsSharing ? "使用 Bilibili App 扫码确认。登录可同时用于视频和未单独登录的动态订阅。" :
          "使用 Bilibili App 扫码确认。登录由 TuneWeave 保存，Lotus-Yunzai 仅保存账号引用。",
        qrDataUrl: qr.qrDataUrl,
        profileId: "bilibili",
      }, {
        saveId: `media-bilibili-login-${context.user_id || "master"}`,
      }).catch(() => undefined)
      active.throwIfAborted()
      const link = typeof qr.url === "string" && URL.parse(qr.url)
      const prompt = image ? { type: "image" as const, file: image } :
        link && link.origin === "https://passport.bilibili.com" && !link.username && !link.password && !link.hash
          ? "二维码图片暂不可用。请在 3 分钟内打开 B 站登录链接。\n" + link.href : undefined
      if (!prompt) return "二维码图片暂不可用，请稍后重试。"
      let delivered = false
      await context.reply(prompt, false, { onDelivered: () => { delivered = true } })
      if (!delivered) return "B 站登录二维码送达未确认，请重试。"
      active.throwIfAborted()
      const result = await service.waitQrLogin({ qrcodeKey: qr.qrcodeKey, signal: active })
      const report = await renderStatusCard({
        title: "B站登录",
        subtitle: "Lotus-Yunzai · B 站",
        badge: "完成",
        message: allowsSharing ? "B站账号已保存，可用于视频及没有可用独立会话的动态订阅。" :
          "B站账号引用已保存，后续搜索和解析会自动使用。",
        userId: context.user_id,
        items: [
          { label: "来源", value: result.account.source },
          { label: "保存时间", value: result.account.saved_at },
        ],
      }, { saveId: `media-bilibili-login-ok-${context.user_id || "master"}` }).catch(() => undefined)
      active.throwIfAborted()
      return report ? { type: "image", file: report } : "[media] B站登录完成。"
    } catch (error) {
      if (active.aborted) return []
      return loginError(context, error instanceof Error ? error.message : "B 站登录未完成，请稍后重试。")
    } finally {
      if (acquired) signingIn = false
    }
  }
  return { command, fallback }
}
