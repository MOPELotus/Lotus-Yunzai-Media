import { load } from "cheerio"
import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { loadPublicShareConfig } from "../../core/config/global.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderSourceCard } from "../../core/render/source-cards.ts"
import type { MediaFetch } from "../media/cdn.ts"
import { buildMediaMessageText, isMediaCommandText } from "../media/message.ts"
import { readPublicSharePage } from "../public-share/page.ts"

const feature = "[media] 小红书公开预览"
const notePath = /^\/(?:explore|discovery\/item)\/([0-9a-f]{24})\/?$/iu
const shortPath = /^\/(?:[ao]\/[A-Za-z0-9]{3,32}|[A-Za-z0-9]{3,32})\/?$/u
const shortHosts = new Set(["xhslink.com", "xhslink.cn"])
const noteHosts = new Set(["www.xiaohongshu.com", "xiaohongshu.com", "m.xiaohongshu.com"])
const maxCover = 3 * 1024 * 1024

function share(value: string) {
  if (value.length > 4096) return
  const url = URL.parse(value)
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) return
  url.hash = ""
  const id = notePath.exec(url.pathname)?.[1]?.toLowerCase()
  if (id && noteHosts.has(url.hostname)) return { url, id }
  if (shortHosts.has(url.hostname) && shortPath.test(url.pathname)) return { url, id: undefined }
}

function identify(message: string, context: MessageFallbackContext) {
  if (context.isDelegated || (context.message_type !== "group" && context.message_type !== "private") || isMediaCommandText(message)) return
  const content = buildMediaMessageText({ ...context, msg: message }).replaceAll("\\/", "/")
  for (const [value] of content.matchAll(/(?<=^|[\s\p{Ps}\p{Pi}"'：，、；])https?:\/\/[^\s<>"'\p{Pe}\p{Pf}。，、！？；：]+/giu)) {
    const input = share(value.replace(/[.,!;]+$/u, "").replaceAll("&amp;", "&"))
    if (input) {
      input.url.protocol = "https:"
      return input
    }
  }
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, limit: number) {
  return typeof value === "string" ? Array.from(value.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").trim())
    .slice(0, limit).join("") : ""
}

function coverUrl(value: unknown, fileId: unknown) {
  const url = typeof value === "string" && value.length <= 4096 ? URL.parse(value) : undefined
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port || url.hash ||
      !/^sns-webpic-[a-z0-9]+\.xhscdn\.com$/u.test(url.hostname) || typeof fileId !== "string" || !/^(?:[a-z0-9_]{1,40}\/)?[a-z0-9]{12,80}$/u.test(fileId) ||
      !url.pathname.split("!", 1)[0]?.endsWith("/" + fileId)) return
  url.protocol = "https:"
  return url
}

export function parseXiaohongshuPage(html: string, id: string) {
  const $ = load(html)
  const canonical = $('head link[rel="canonical"]')
  const ogUrl = $('head meta[property="og:url"]')
  if (canonical.length !== 1 || share(canonical.attr("href") ?? "")?.id !== id ||
      ogUrl.length !== 1 || share(ogUrl.attr("content") ?? "")?.id !== id) return
  const states = $("script:not([src])").toArray().map(node => $(node).text().trim()).filter(value => value.startsWith("window.__INITIAL_STATE__="))
  if (states.length !== 1) return
  const json = states[0]!.slice("window.__INITIAL_STATE__=".length).replace(/;\s*$/u, "")
    // The page emits JavaScript's undefined in otherwise JSON-shaped state. Keep all string contents literal.
    .replace(/"(?:[^"\\]|\\[\s\S])*"|\bundefined\b/gu, value => value === "undefined" ? "null" : value)
  let state: Record<string, unknown>
  try { state = fields(JSON.parse(json)) } catch { return }
  const detail = fields(fields(fields(state.note).noteDetailMap)[id])
  const note = fields(detail.note)
  if (note.noteId !== id || (note.type !== "normal" && note.type !== "video")) return
  const owner = text(fields(note.user).nickname, 100)
  const body = text(note.desc, 1200)
  const heading = text(note.title, 200)
  const title = heading || text(body.split("\n", 1)[0], 140) || "小红书笔记"
  const firstImage = Array.isArray(note.imageList) ? fields(note.imageList[0]) : {}
  const cover = coverUrl(firstImage.urlDefault, firstImage.fileId) ?? coverUrl(firstImage.urlPre, firstImage.fileId)
  if (!owner || (!heading && !body && !cover)) return
  return { title, owner, desc: heading ? body : body.slice(title.length).trimStart(), cover }
}

async function readCover(cover: URL | undefined, fetch: MediaFetch, signal: AbortSignal) {
  if (!cover) return
  try {
    const response = await fetch(cover.href, { credentials: "omit", redirect: "error", signal })
    if (response.status !== 200 || response.redirected || !response.body ||
        Number(response.headers.get("content-length")) > maxCover ||
        !/^image\/(?:jpeg|png|webp)(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel().catch(() => undefined)
      return
    }
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      signal.throwIfAborted()
      size += chunk.byteLength
      if (size > maxCover) return
      chunks.push(chunk)
    }
    if (size) return Buffer.concat(chunks, size)
  } catch { signal.throwIfAborted() }
}

export function createXiaohongshuPreview({ signal, fetch = globalThis.fetch, loadConfig = loadPublicShareConfig,
  render = renderSourceCard }: {
  readonly signal?: AbortSignal
  readonly fetch?: MediaFetch
  readonly loadConfig?: typeof loadPublicShareConfig
  readonly render?: typeof renderSourceCard
} = {}) {
  return {
    features: (context: MessageFallbackContext) => identify(context.normalizedMessage, context) ? [feature] : [],
    async fallback(message: string, context: MessageFallbackContext) {
      const input = identify(message, context)
      if (!input) return
      const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
      if (context.message_type === "private" && !connection) return
      const active = AbortSignal.any([signal, connection].filter((value): value is AbortSignal => value !== undefined))
      if (active.aborted) return []
      const link = input.url.href
      const unavailable = "暂无法读取小红书公开笔记。\n" + link
      let enabled = false
      try {
        const config = await loadConfig("xhs")
        enabled = config.enable && (context.message_type !== "private" || config.privatePreview) &&
          new PermissionService({ permissions: config.permissions }).can(context, "xhs.preview")
        if (!enabled || active.aborted) return
        const deadline = AbortSignal.any([active, AbortSignal.timeout(8_000)])
        let id = input.id
        const page = await readPublicSharePage(input.url, next => {
          if (next.protocol !== "https:") return false
          const known = share(next.href)
          if (!known) return false
          if (id) return known.id === id
          id = known.id
          return true
        }, fetch, deadline, { Accept: "text/html" })
        const result = page && id && parseXiaohongshuPage(page.html, id)
        if (active.aborted) return []
        if (!result) return unavailable
        const cover = await readCover(result.cover, fetch, deadline)
        if (active.aborted) return []
        const card = { ...result, cover, type: "public-link", showStats: false, id: `小红书 · ${id}` }
        const limit = context.inlineImageByteLimit ?? 16 * 1024 * 1024
        let image = await render("bilibili-info", card).catch(() => undefined)
        if (image && image.byteLength > limit && !active.aborted) image = await render("bilibili-info", card, { renderScale: 2 }).catch(() => undefined)
        if (active.aborted) return []
        return image && image.byteLength <= limit ? [{ type: "image" as const, file: image }, { type: "text" as const, text: link }]
          : [result.title, result.owner, result.desc, link].filter(Boolean).join("\n")
      } catch { if (enabled && !active.aborted) return unavailable }
    },
  }
}
