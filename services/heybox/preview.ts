import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { loadPublicShareConfig } from "../../core/config/global.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderSourceCard } from "../../core/render/source-cards.ts"
import type { MediaFetch } from "../media/cdn.ts"
import { buildMediaMessageText, isMediaCommandText } from "../media/message.ts"

const endpoint = "https://api.xiaoheihe.cn/game/share_game_detail"
const landing = "https://www.xiaoheihe.cn/game/share_game_detail"
const feature = "[media] 小黑盒 PC 游戏预览"
const sharePattern = /(?<=^|[\s\p{Ps}\p{Pi}"'：，、；])https:\/\/api\.xiaoheihe\.cn\/game\/share_game_detail\?[^\s<>"'\p{Pe}\p{Pf}。，、！？；：]+/giu
const shareParams = new Set(["appid", "game_type", "h_src", "h_camp", "h_session_id"])
const landingParams = new Set(["appid", "game_type", "title"])

function onlySingleParams(params: URLSearchParams, allowed: ReadonlySet<string>) {
  return [...params.keys()].every(key => allowed.has(key) && params.getAll(key).length === 1)
}

export function parseHeyboxShare(link: string) {
  if (link.length > 768 || !link.startsWith(endpoint + "?") || /[\p{Cc}\p{Cf}\s\\]/u.test(link)) return
  const url = URL.parse(link)
  if (!url || !onlySingleParams(url.searchParams, shareParams)) return
  const id = url.searchParams.get("appid")
  if (url.searchParams.get("game_type") !== "pc" || !id || !/^[1-9][0-9]{0,9}$/u.test(id)) return
  return { id, link }
}

function identify(message: string, context: MessageFallbackContext) {
  if (context.isDelegated || (context.message_type !== "group" && context.message_type !== "private") ||
      /^\s*[#＃]总结一下/u.test(message) || isMediaCommandText(message)) return
  const content = buildMediaMessageText({ ...context, msg: message }).replaceAll("\\/", "/")
  for (const [link] of content.matchAll(sharePattern)) {
    const source = parseHeyboxShare(link.replace(/[.,!;]+$/u, "").replaceAll("&amp;", "&"))
    if (source) return source
  }
}

async function readGameTitle(id: string, fetch: MediaFetch, signal: AbortSignal) {
  const response = await fetch(`${endpoint}?appid=${id}&game_type=pc`, { credentials: "omit", redirect: "manual", signal })
  await response.body?.cancel().catch(() => undefined)
  if (response.status !== 302 || response.redirected) return
  const location = response.headers.get("location")
  if (!location || location.length > 4096 || !location.startsWith(landing + "?") || /[\p{Cc}\p{Cf}\s\\]/u.test(location)) return
  const url = URL.parse(location)
  if (!url || url.hash || !onlySingleParams(url.searchParams, landingParams) ||
      url.searchParams.get("appid") !== id || url.searchParams.get("game_type") !== "pc") return
  const title = url.searchParams.get("title")
  if (!title || Array.from(title).length > 120 || !/[\p{L}\p{N}]/u.test(title) ||
      /[\p{Cc}\p{Cf}\uFFFD\u2028\u2029<>]|(?:https?:\/\/|\[CQ:)/iu.test(title)) return
  return title.trim()
}

export function createHeyboxPreview({ signal, fetch = globalThis.fetch, loadConfig = loadPublicShareConfig,
  render = renderSourceCard }: {
  readonly signal?: AbortSignal
  readonly fetch?: MediaFetch
  readonly loadConfig?: typeof loadPublicShareConfig
  readonly render?: typeof renderSourceCard
} = {}) {
  return {
    features: (context: MessageFallbackContext) =>
      !signal?.aborted && identify(context.normalizedMessage, context) ? [feature] : [],
    async fallback(message: string, context: MessageFallbackContext) {
      const source = identify(message, context)
      if (!source) return
      const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
      if (context.message_type === "private" && !connection) return
      const active = AbortSignal.any([signal, connection].filter((value): value is AbortSignal => value !== undefined))
      if (active.aborted) return []
      const config = await loadConfig("xhh").catch(() => undefined)
      if (!config?.enable || (context.message_type === "private" && !config.privatePreview) ||
          !new PermissionService({ permissions: config.permissions }).can(context, "xhh.preview")) return
      if (active.aborted) return []
      const deadline = AbortSignal.any([active, AbortSignal.timeout(8_000)])
      const title = await readGameTitle(source.id, fetch, deadline).catch(() => undefined)
      if (active.aborted) return []
      if (!title) return "暂无法读取小黑盒游戏名称。\n" + source.link
      const card = { title, type: "public-link", owner: "小黑盒", id: "PC 游戏", showStats: false }
      const limit = context.inlineImageByteLimit ?? 16 * 1024 * 1024
      let image = await render("bilibili-info", card).catch(() => undefined)
      if (image && image.byteLength > limit && !active.aborted) image = await render("bilibili-info", card, { renderScale: 2 }).catch(() => undefined)
      if (active.aborted) return []
      return image && image.byteLength <= limit ? [{ type: "image" as const, file: image }, { type: "text" as const, text: source.link }]
        : title + "\n" + source.link
    },
  }
}
