import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import type { MessageReply } from "../../../../lib/messages.ts"
import { renderTemplate } from "../../core/render/service.ts"
import { buildMediaMessageText } from "../media/message.ts"
import { createOfficialLinkSettings, officialLinkTrustFields } from "./settings.ts"
import { getOfficialLink, parseOfficialLink, officialLinkNames, type OfficialLinkFetch } from "./source.ts"

const link = /(?<=^|[\s\p{Ps}\p{Pi}"'：，、；])https?:\/\/[^\s<>"'\p{Pe}\p{Pf}。，、！？；：]+/giu

export function* messageLinkValues(message: string, context: MessageFallbackContext) {
  const contents = buildMediaMessageText({ ...context, msg: message }).replaceAll("\\/", "/")
  for (const [value] of contents.matchAll(link)) yield value.replace(/[.,!;]+$/u, "")
}

function identify(message: string, context: MessageFallbackContext) {
  if (context.isDelegated || (context.message_type !== "group" && context.message_type !== "private")) return
  if (/^\s*[#＃]/u.test(message)) {
    const explicit = /^\s*[#＃]总结一下\s*(https?:\/\/\S+)\s*$/iu.exec(message)?.[1]
    const input = explicit && parseOfficialLink(explicit)
    if (input && input.platform === "v2ex") return input
    return
  }
  for (const value of messageLinkValues(message, context)) {
    const input = parseOfficialLink(value)
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
        const trust = input.platform === "telegram" || input.platform === "x" ? input.platform : undefined
        const options = await settings(context.isMaster ? false : trust ?? false)
        enabled = options[input.platform] && (context.message_type !== "private" || options.private)
        if (!enabled || active.aborted) return
        if (trust && !context.isMaster && !options[officialLinkTrustFields[trust]].includes(String(context.user_id))) {
          if (trust === "x") return $t("services.official-links.command.text_64938f18f7")
          return
        }
        const preview = await getOfficialLink(input, fetcher, AbortSignal.any([active, AbortSignal.timeout(8000)]))
        if (active.aborted) return
        if (!preview) return $t("services.official-links.command.text_db4d59eabd", { "platform": platform, "link": input.link })
        const { link = input.link, ...content } = preview
        const card = { ...content, id: `${platform} · ${input.id}`, type: "public-link", showStats: false }
        const limit = context.inlineImageByteLimit ?? Infinity
        let image = await render("bilibili-info", card).catch(() => undefined)
        if (image && image.byteLength > limit && !active.aborted) {
          image = await render("bilibili-info", card, { renderScale: 2 }).catch(() => undefined)
        }
        if (active.aborted) return
        if (image && image.length <= limit) return [{ type: "image", file: image }, { type: "text", text: link }]
        return [preview.title, preview.owner, preview.desc, link].filter(Boolean).join("\n")
      } catch {
        if (enabled && !active.aborted) return $t("services.official-links.command.text_db4d59eabd", { "platform": platform, "link": input.link })
      }
    },
  }
}
