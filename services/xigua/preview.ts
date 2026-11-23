import { load } from "cheerio"
import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { fetchImageBytes } from "../../core/render/image.ts"
import { renderSourceCard } from "../../core/render/source-cards.ts"
import type { MediaFetch } from "../media/cdn.ts"
import { buildMediaMessageText, isMediaCommandText } from "../media/message.ts"
import { readPublicSharePage } from "../public-share/page.ts"
import { createPublicShareSettings } from "../public-share/settings.ts"

const mobile = "https://m.ixigua.com"
const shortHost = "https://v.ixigua.com"
const feature = "[media] 西瓜视频解析"
const redirect = new Set([301, 302, 303, 307, 308])
const linkPattern = /(?<=^|[\s\p{Ps}\p{Pi}"'：，、；])(?:https?:\/\/|(?=(?:www|v|m)\.ixigua\.com\/))[^\s<>"'\p{Pe}\p{Pf}。，、！？；：]+/giu
export const xiguaFields = [["enable", "解析西瓜视频链接"], ["private", "西瓜视频私聊自动解析"]] as const

type Share = { readonly id: string; readonly link: string } | { readonly id?: undefined; readonly link: string }

function url(value: string) {
  const parsed = URL.parse(value)
  if (parsed && (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password && !parsed.port) {
    parsed.protocol = "https:"
    return parsed
  }
}

export function parseXiguaShare(value: string): Share | undefined {
  const source = url(value)
  if (!source) return
  if (source.origin === shortHost) {
    const code = /^\/([A-Za-z0-9]{3,32})\/?$/u.exec(source.pathname)?.[1]
    if (code) return { link: `${shortHost}/${code}/` }
    return
  }
  const id = source.origin === "https://www.ixigua.com" ? /^\/([1-9]\d{9,19})\/?$/u.exec(source.pathname)?.[1]
    : source.origin === mobile ? /^\/video\/([1-9]\d{9,19})\/?$/u.exec(source.pathname)?.[1] : undefined
  if (id) return { id, link: `${mobile}/video/${id}` }
}

function identify(message: string, context: MessageFallbackContext) {
  if (context.isDelegated || (context.message_type !== "group" && context.message_type !== "private") || isMediaCommandText(message)) return
  const contents = buildMediaMessageText({ ...context, msg: message }).replaceAll("\\/", "/")
  for (const [found] of contents.matchAll(linkPattern)) {
    const plain = found.replace(/[.,!;]+$/u, "")
    const target = parseXiguaShare(/^https?:/iu.test(plain) ? plain : "https://" + plain)
    if (target) return target
  }
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, size: number) {
  return typeof value === "string" ? Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, size).join("") : ""
}

function coverUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4096) return
  const cover = URL.parse(value)
  if (cover?.protocol === "https:" && !cover.port && !cover.username && !cover.password && !cover.hash &&
      /^p[1-9]\d?-sign\.douyinpic\.com$/u.test(cover.hostname) && /^\/tos-cn-[ip]-[a-z0-9]+\/[A-Za-z0-9._~-]+$/u.test(cover.pathname)) return cover
}

function duration(value: unknown) {
  if (typeof value !== "string") return
  const match = /^PT(?:(\d{1,3})H)?(?:(\d{1,2})M)?(?:(\d{1,2}(?:\.\d{1,3})?)S)?$/u.exec(value)
  if (match && match.some((part, index) => index > 0 && part !== undefined)) {
    return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
  }
}

export function parseXiguaPage(html: string, id: string) {
  const $ = load(html)
  const canonical = $('head link[rel="canonical"]')
  if (canonical.length !== 1 || parseXiguaShare(canonical.attr("href") ?? "")?.link !== `${mobile}/video/${id}`) return
  const posts = $('head script[type="application/ld+json"]').toArray().flatMap(node => {
    try {
      const data = fields(JSON.parse($(node).text()))
      const embed = typeof data.embedUrl === "string" ? parseXiguaShare(data.embedUrl) : undefined
      return data["@type"] === "VideoObject" && embed?.id === id ? [data] : []
    } catch { return [] }
  })
  if (posts.length !== 1) return
  const post = posts[0]!
  const title = text(typeof post.name === "string" ? post.name.replace(/\s*\|\s*西瓜视频\s*$/u, "") : "", 240)
  const owner = text(fields(post.author).name, 100)
  if (!title || !owner) return
  const covers = Array.isArray(post.thumbnailUrl) ? post.thumbnailUrl : [post.thumbnailUrl]
  const cover = covers.flatMap(item => coverUrl(item) ?? [])[0]
  const published = typeof post.uploadDate === "string" ? Date.parse(post.uploadDate) : NaN
  const views = fields(post.interactionStatistic).userInteractionCount
  return { title, owner, cover, duration: duration(post.duration), createdAt: Number.isFinite(published) ? Math.floor(published / 1000) : undefined,
    view: typeof views === "number" && Number.isSafeInteger(views) && views >= 0 ? views : undefined }
}

async function resolveShare(target: Share, fetch: MediaFetch, signal: AbortSignal) {
  for (let hop = 0; hop < 3 && !target.id; hop++) {
    const response = await fetch(target.link, { redirect: "manual", credentials: "omit", signal })
    await response.body?.cancel().catch(() => undefined)
    if (!redirect.has(response.status) || response.redirected) return
    const location = response.headers.get("location")
    const nextUrl = location ? URL.parse(location, target.link) : undefined
    const next = nextUrl && parseXiguaShare(nextUrl.href)
    if (!next) return
    target = next
  }
  return target.id ? target : undefined
}

async function readCover(cover: URL | undefined, fetch: MediaFetch, signal: AbortSignal) {
  if (!cover) return
  try {
    return await fetchImageBytes(cover.href, { signal, maxBytes: 2 * 1024 * 1024, fetch: async (value, options) => {
      if (value !== cover.href) throw new Error("西瓜视频封面地址已变化。")
      const response = await fetch(value, { ...options, credentials: "omit", redirect: "error" })
      if (response.status === 200 && !response.redirected && /^image\/(?:jpeg|png|webp)(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) return response
      await response.body?.cancel().catch(() => undefined)
      throw new Error("西瓜视频封面不可用。")
    } })
  } catch { signal.throwIfAborted() }
}

export function createXiguaPreview({ signal, fetch = globalThis.fetch, loadConfig = loadGlobalConfig,
  render = renderSourceCard, settings = createPublicShareSettings("xigua", "西瓜视频") }: {
  readonly signal?: AbortSignal
  readonly fetch?: MediaFetch
  readonly loadConfig?: typeof loadGlobalConfig
  readonly render?: typeof renderSourceCard
  readonly settings?: Pick<ReturnType<typeof createPublicShareSettings>, "settings">
} = {}) {
  return {
    features: (context: MessageFallbackContext) => identify(context.normalizedMessage, context) ? [feature] : [],
    async fallback(message: string, context: MessageFallbackContext) {
      const source = identify(message, context)
      if (!source) return
      const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
      if (context.message_type === "private" && !connection) return
      const active = AbortSignal.any([signal, connection].filter((value): value is AbortSignal => value !== undefined))
      if (active.aborted) return []
      const unavailable = "暂无法读取西瓜视频公开预览。\n" + source.link
      let enabled = false
      try {
        const config = await loadConfig()
        const options = await settings.settings(config.tools)
        enabled = options.enable && (context.message_type !== "private" || options.private) &&
          new PermissionService({ permissions: config.permissions }).can(context, "xigua.preview")
        if (!enabled || active.aborted) return
        const deadline = AbortSignal.any([active, AbortSignal.timeout(8_000)])
        const resolved = await resolveShare(source, fetch, deadline)
        if (!resolved) return unavailable
        const page = await readPublicSharePage(new URL(resolved.link), next => next.origin === mobile &&
          parseXiguaShare(next.href)?.link === resolved.link, fetch, deadline, { Accept: "text/html" })
        if (active.aborted) return []
        const post = page && parseXiguaPage(page.html, resolved.id)
        if (!post) return unavailable
        const cover = await readCover(post.cover, fetch, deadline)
        if (active.aborted) return []
        const card = { title: post.title, owner: post.owner, id: `西瓜视频 · ${resolved.id}`, type: "video", cover,
          duration: post.duration, createdAt: post.createdAt, showStats: false,
          desc: post.view === undefined ? undefined : `播放 ${post.view.toLocaleString("zh-CN")}` }
        const limit = context.inlineImageByteLimit ?? 16 * 1024 * 1024
        let image = await render("bilibili-info", card).catch(() => undefined)
        if (image && image.byteLength > limit && !active.aborted) image = await render("bilibili-info", card, { renderScale: 2 }).catch(() => undefined)
        if (active.aborted) return []
        return image && image.byteLength <= limit ? [{ type: "image" as const, file: image }, { type: "text" as const, text: resolved.link }]
          : [card.title, card.owner, card.desc, resolved.link].filter(Boolean).join("\n")
      } catch { if (enabled && !active.aborted) return unavailable }
    },
  }
}
