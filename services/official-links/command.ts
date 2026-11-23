import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import type { MessageReply } from "../../../../lib/messages.ts"
import { renderTemplate } from "../../core/render/service.ts"
import { buildMediaMessageText } from "../media/message.ts"
import { createOfficialLinkSettings } from "./settings.ts"
import { getOfficialLink, parseOfficialLink, officialLinkNames, type OfficialLinkFetch } from "./source.ts"

const link = /(?<=^|[\s\p{Ps}\p{Pi}"'：，、；])https?:\/\/[^\s<>"'\p{Pe}\p{Pf}。，、！？；：]+/giu

function identify(message: string, context: MessageFallbackContext) {
  if (context.isDelegated || (context.message_type !== "group" && context.message_type !== "private")) return
  if (/^\s*[#＃]/u.test(message)) {
    const explicit = /^\s*[#＃]总结一下\s*(https?:\/\/\S+)\s*$/iu.exec(message)?.[1]
    const input = explicit && parseOfficialLink(explicit)
    if (input && input.platform === "v2ex") return input
    return
  }
  const contents = buildMediaMessageText({ ...context, msg: message }).replaceAll("\\/", "/")
  for (const [value] of contents.matchAll(link)) {
    const input = parseOfficialLink(value.replace(/[.,!;]+$/u, ""))
    if (input) return input
  }
}

export function createOfficialLinkPreview({
  signal, settings = createOfficialLinkSettings().settings, fetcher = fetch, render = renderTemplate,
}: {
  readonly signal?: AbortSignal
  readonly settings?: ReturnType<typeof createOfficialLinkSettings>["settings"]
  readonly fetcher?: OfficialLinkFetch
  readonly render?: typeof renderTemplate
}) {
  return {
    features(context: MessageFallbackContext) {
      const input = !signal?.aborted && identify(context.normalizedMessage, context)
      return input ? [`[media] ${officialLinkNames[input.platform]} 预览`] : []
    },
    async fallback(message: string, context: MessageFallbackContext): Promise<MessageReply | undefined> {
      const input = identify(message, context)
      if (!input) return
      const scopes = [signal, context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal]
        .filter((scope): scope is AbortSignal => !!scope)
      const active = AbortSignal.any(scopes)
      if (active.aborted) return
      const platform = officialLinkNames[input.platform]
      let enabled = false
      try {
        const options = await settings(input.platform === "telegram" && !context.isMaster)
        enabled = options[input.platform] &&
          (context.message_type !== "private" || options.private) &&
          (input.platform !== "telegram" || context.isMaster || options.trustedTelegramUsers.includes(String(context.user_id)))
        if (!enabled || active.aborted) return
        const preview = await getOfficialLink(input, fetcher, AbortSignal.any([active, AbortSignal.timeout(8000)]))
        if (active.aborted) return
        if (!preview) return `${platform} 暂无法读取公开预览。\n${input.link}`
        const card = { ...preview, id: `${platform} · ${input.id}`, type: "public-link", showStats: false }
        const limit = context.inlineImageByteLimit ?? Infinity
        let image = await render("bilibili-info", card).catch(() => undefined)
        if (image && image.byteLength > limit && !active.aborted) {
          image = await render("bilibili-info", card, { renderScale: 2 }).catch(() => undefined)
        }
        if (active.aborted) return
        if (image && image.length <= limit) return [{ type: "image", file: image }, { type: "text", text: input.link }]
        return [preview.title, preview.owner, preview.desc, input.link].filter(Boolean).join("\n")
      } catch {
        if (enabled && !active.aborted) return `${platform} 暂无法读取公开预览。\n${input.link}`
      }
    },
  }
}
