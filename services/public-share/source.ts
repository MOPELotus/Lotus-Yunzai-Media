import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { readPublicResponse } from "../public-read.ts"
import { load } from "cheerio"
import { publicShareVideoUrl, type MediaFetch } from "../media/cdn.ts"

type Site = "weishi" | "zuiyou"
type Target = { site: Site; url: URL; id?: string }
export type PublicShare = {
  readonly site: Site
  readonly id: string
  readonly url: string
  readonly title: string
  readonly owner: string
  readonly createdAt?: number
  readonly duration?: number
  readonly cover?: string
  readonly images: readonly string[]
  readonly video?: URL
}

const weishiPath = "/ws/app-pages/share/index.html"
const zuiyouPath = "/hybrid/share/post"
const weishiId = /^[A-Za-z0-9]{8,40}$/u
const zuiyouId = /^[1-9]\d{0,15}$/u
const imageHosts = { weishi: new Set(["pic.weishi.qq.com", "xp.qpic.cn"]), zuiyou: new Set(["web-f01.izuiyou.com"]) }

function sourceUrl(value: unknown) {
  const url = typeof value === "string" && value.length < 4096 ? URL.parse(value) : undefined
  if (url && (url.protocol === "https:" || url.protocol === "http:") && !url.port && !url.username && !url.password && !url.hash) {
    url.protocol = "https:"
    return url
  }
}

export function parsePublicShare(value: string): Target | undefined {
  const url = sourceUrl(value)
  if (!url) return
  if (url.hostname === "video.weishi.qq.com" && /^\/[A-Za-z0-9]{4,32}$/u.test(url.pathname)) {
    url.search = ""
    return { site: "weishi", url }
  }
  if (url.hostname === "isee.weishi.qq.com" && url.pathname === weishiPath) {
    const ids = url.searchParams.getAll("id")
    if (ids.length === 1 && weishiId.test(ids[0]!)) {
      url.search = new URLSearchParams({ wxplay: "1", id: ids[0]! }).toString()
      return { site: "weishi", url, id: ids[0] }
    }
  }
  if (url.hostname === "share.xiaochuankeji.cn" && url.pathname === zuiyouPath) {
    const ids = url.searchParams.getAll("pid")
    if (ids.length === 1 && zuiyouId.test(ids[0]!)) {
      url.search = new URLSearchParams({ pid: ids[0]! }).toString()
      return { site: "zuiyou", url, id: ids[0] }
    }
  }
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function label(value: unknown, limit: number) {
  return typeof value === "string" ? Array.from(value.trim().replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")).slice(0, limit).join("") : ""
}

function image(value: unknown, site: Site) {
  const url = sourceUrl(value)
  if (url && imageHosts[site].has(url.hostname)) return url.href
}

function timestamp(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 4_102_444_800 ? value : undefined
}

function weishi(html: string, target: Target): PublicShare | undefined {
  const document = load(html)
  const script = document("script").toArray().map(element => document(element).text())
    .find(source => /^\s*try\s*\{\s*window\.Vise\.initState\s*=/u.test(source))
  const json = script && /^\s*try\s*\{\s*window\.Vise\.initState\s*=\s*(\{[\s\S]*\})\s*;\s*\}\s*catch\b/u.exec(script)?.[1]
  const payload = record(json ? JSON.parse(json) : undefined)
  const matches = Array.isArray(payload.feedsList) ? payload.feedsList.filter(feed => record(feed).id === target.id) : []
  if (matches.length !== 1 || !target.id) return
  const feed = record(matches[0])
  const title = label(feed.feedDesc, 180)
  const owner = label(record(feed.poster).nick, 80)
  if (!title && !owner) return
  const duration = record(feed.video).duration
  const video = typeof feed.videoUrl === "string" ? publicShareVideoUrl(feed.videoUrl, "weishi-video") : undefined
  return { site: "weishi", id: target.id, url: target.url.href, title: title || $t("services.public-share.source.text_e96dc61f95"), owner,
    cover: image(feed.videoCover, "weishi"), images: [], video, createdAt: timestamp(feed.createTime),
    duration: typeof duration === "number" && duration > 0 && duration < 86_400_000 ? duration / 1000 : undefined }
}

function zuiyou(html: string, target: Target): PublicShare | undefined {
  const script = load(html)("script#appState").text()
  const json = /^\s*window\.APP_INITIAL_STATE\s*=\s*(\{[\s\S]*\})\s*;?\s*$/u.exec(script)?.[1]
  const state = record(json ? JSON.parse(json) : undefined)
  const post = record(record(record(state.sharePost).postDetail).post)
  if (String(post.id) !== target.id || !target.id || post.privateStatus !== 0) return
  const title = label(post.content, 180)
  const owner = label(record(post.member).name, 80)
  if (!title && !owner) return
  const images: string[] = []
  let video: URL | undefined, cover: string | undefined, duration: number | undefined
  for (const item of Array.isArray(post.imgs) ? post.imgs.slice(0, 20) : []) {
    const row = record(item)
    const sizes = record(row.urls)
    const urls = record(sizes["540"]).urls
    const picture = Array.isArray(urls) ? image(urls[0], "zuiyou") : undefined
    if (row.video === 1 || row.video === true) {
      const entry = record(record(post.videos)[String(row.id)])
      if (!video && typeof entry.url === "string") {
        video = publicShareVideoUrl(entry.url, "zuiyou-video")
        cover = picture
        if (typeof entry.dur === "number" && entry.dur > 0 && entry.dur < 86_400) duration = entry.dur
      }
    } else if (picture && !images.includes(picture)) images.push(picture)
  }
  return { site: "zuiyou", id: target.id, url: target.url.href, title: title || $t("services.public-share.source.text_7025dd3007"), owner,
    cover: cover ?? images[0], images, video, duration, createdAt: timestamp(post.ct) }
}

async function htmlOf(response: Response, signal: AbortSignal) {
  const limit = 512 * 1024
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel()
    return
  }
  let bytes = 0, html = ""
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    signal.throwIfAborted()
    bytes += chunk.byteLength
    if (bytes > limit) throw new Error($t("services.public-share.source.text_e682885277"))
    html += decoder.decode(chunk, { stream: true })
  }
  return html + decoder.decode()
}

export async function readPublicShare(target: Target, signal: AbortSignal, fetch: MediaFetch = globalThis.fetch) {
  const active = AbortSignal.any([signal, AbortSignal.timeout(8_000)])
  let current = target
  for (let hop = 0; hop <= 3; hop++) {
    const response = await readPublicResponse(fetch, current.url.href, { signal: active, credentials: "omit", redirect: "manual" })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get("Location")
      const parsed = location && URL.parse(location, current.url)
      if (!parsed || parsed.protocol !== "https:") return
      const next = parsePublicShare(parsed.href)
      if (next?.site !== target.site || target.id && next.id !== target.id) return
      current = next
      continue
    }
    if (!current.id) {
      await response.body?.cancel()
      return
    }
    const html = await htmlOf(response, active)
    if (html) return current.site === "weishi" ? weishi(html, current) : zuiyou(html, current)
    return
  }
}
