import { load } from "cheerio"
import { parseXLink, xPreview, type OfficialXLink } from "./x.ts"

export type OfficialLink =
  | { readonly platform: "youtube" | "youtubeMusic"; readonly id: string; readonly link: string }
  | OfficialXLink
  | { readonly platform: "v2ex"; readonly id: string; readonly link: string }
  | { readonly platform: "telegram"; readonly username: string; readonly id: string; readonly link: string }

export const officialLinkNames = {
  youtube: "YouTube", youtubeMusic: "YouTube Music", telegram: "Telegram", v2ex: "V2EX", x: "X",
} as const

interface PublicPreview {
  readonly title: string
  readonly owner: string
  readonly desc?: string
  readonly cover?: Buffer
  readonly link?: string
}

export type OfficialLinkFetch = (url: URL, request: RequestInit) => Promise<Response>
const videoId = /^[\w-]{11}$/u
const videoHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"])
const thumbnailHosts = new Set(["i.ytimg.com", "img.youtube.com"])
const v2exHosts = new Set(["v2ex.com", "www.v2ex.com", "fast.v2ex.com", "global.v2ex.com"])

function publicUrl(value: unknown) {
  const url = typeof value === "string" && value.length <= 2048 ? URL.parse(value) : undefined
  if (url && (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.port) return url
}

export function parseOfficialLink(value: string): OfficialLink | undefined {
  const url = publicUrl(value)
  if (!url) return
  if (v2exHosts.has(url.hostname)) {
    const id = /^\/t\/([1-9]\d{0,14})\/?$/u.exec(url.pathname)?.[1]
    if (!id) return
    const original = new URL("https://www.v2ex.com/t/" + id)
    const pages = url.searchParams.getAll("p")
    if (pages.length === 1 && /^[1-9]\d{0,6}$/u.test(pages[0]!)) original.searchParams.set("p", pages[0]!)
    if (/^#reply[1-9]\d{0,8}$/u.test(url.hash)) original.hash = url.hash
    return { platform: "v2ex", id, link: original.href }
  }
  if (url.hostname === "t.me") {
    const post = /^\/([A-Za-z][A-Za-z0-9_]{3,31})\/([1-9]\d{0,18})\/?$/u.exec(url.pathname)
    if (!post?.[1] || !post[2] || url.search) return
    const username = post[1].toLowerCase()
    if (["joinchat", "share", "addstickers", "proxy"].includes(username)) return
    return { platform: "telegram", username, id: post[2], link: `https://t.me/${username}/${post[2]}` }
  }
  const x = parseXLink(url, true)
  if (x) return x
  const short = url.hostname === "youtu.be"
  if (!short && (!videoHosts.has(url.hostname) || url.pathname !== "/watch" || url.searchParams.getAll("v").length !== 1)) return
  const id = short ? url.pathname.slice(1) : url.searchParams.get("v")
  if (!id || !videoId.test(id)) return
  const platform = url.hostname === "music.youtube.com" ? "youtubeMusic" : "youtube"
  const host = short ? "youtu.be" : platform === "youtubeMusic" ? "music.youtube.com" : "www.youtube.com"
  const original = new URL(short ? `https://${host}/${id}` : `https://${host}/watch?v=${id}`)
  const timestamp = url.searchParams.get("t")
  if (timestamp && /^(?:\d{1,8}|(?:\d{1,3}h)?(?:\d{1,4}m)?(?:\d{1,5}s)?)$/u.test(timestamp)) original.searchParams.set("t", timestamp)
  return { platform, id, link: original.href }
}

function text(value: unknown, length: number) {
  return typeof value === "string" ? Array.from(value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim())
    .slice(0, length).join("") : ""
}

async function bounded(fetcher: OfficialLinkFetch, url: URL, signal: AbortSignal, accept: string, limit: number) {
  const response = await fetcher(url, { redirect: "error", credentials: "omit", signal, headers: { Accept: accept } })
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? ""
  const reader = response.body?.getReader()
  if (!reader) throw new Error("来源没有返回公开内容。")
  try {
    if (!response.ok || response.redirected || !accept.split(",").includes(mime) ||
        Number(response.headers.get("content-length")) > limit) throw new Error("来源没有返回可用的公开内容。")
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      signal.throwIfAborted()
      const { value } = await reader.read()
      if (!value) return Buffer.concat(chunks, size)
      size += value.byteLength
      if (size > limit) throw new Error("来源响应超过预览大小限制。")
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function cover(fetcher: OfficialLinkFetch, url: URL | undefined, signal: AbortSignal) {
  if (!url) return
  try {
    const bytes = await bounded(fetcher, url, signal, "image/jpeg,image/png,image/webp", 2 * 1024 * 1024)
    if (bytes.length) return bytes
  } catch {
    signal.throwIfAborted()
  }
}

async function youtube(input: Extract<OfficialLink, { platform: "youtube" | "youtubeMusic" }>,
  fetcher: OfficialLinkFetch, signal: AbortSignal): Promise<PublicPreview | undefined> {
  const endpoint = new URL("https://www.youtube.com/oembed")
  const link = new URL(input.link)
  link.searchParams.delete("t")
  endpoint.searchParams.set("url", link.href)
  const bytes = await bounded(fetcher, endpoint, signal, "application/json", 32 * 1024)
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
  const data = raw as Record<string, unknown>
  if (data.type !== "video" || data.provider_name !== "YouTube" || typeof data.html !== "string") return
  const frames = load(data.html, {}, false)("iframe")
  const player = frames.length === 1 ? publicUrl(frames.attr("src")) : undefined
  if (player?.protocol !== "https:" || player.hostname !== "www.youtube.com" || player.pathname !== `/embed/${input.id}`) return
  const title = text(data.title, 300)
  const owner = text(data.author_name, 100)
  if (!title || !owner) return
  const thumbnail = publicUrl(data.thumbnail_url)
  const image = thumbnail?.protocol === "https:" && thumbnailHosts.has(thumbnail.hostname) &&
    [`/vi/${input.id}/`, `/vi_webp/${input.id}/`].some(path => thumbnail.pathname.startsWith(path)) ? thumbnail : undefined
  if (image?.hostname === "i.ytimg.com" && image.pathname.startsWith(`/vi/${input.id}/`)) image.hostname = "img.youtube.com"
  return { title, owner, cover: await cover(fetcher, image, signal) }
}

async function telegram(input: Extract<OfficialLink, { platform: "telegram" }>, fetcher: OfficialLinkFetch,
  signal: AbortSignal): Promise<PublicPreview | undefined> {
  const endpoint = new URL("https://t.me")
  endpoint.pathname = `/${encodeURIComponent(input.username)}/${encodeURIComponent(input.id)}`
  endpoint.searchParams.set("embed", "1")
  const bytes = await bounded(fetcher, endpoint, signal, "text/html", 192 * 1024)
  const $ = load(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  const posts = $(".tgme_widget_message[data-post]").filter((_, post) =>
    $(post).attr("data-post")?.toLowerCase() === `${input.username}/${input.id}`)
  if (posts.length !== 1) return
  const owner = text(posts.find(".tgme_widget_message_owner_name").first().text(), 100)
  const dateLink = publicUrl(posts.find(".tgme_widget_message_date").first().attr("href"))
  if (!owner || dateLink?.hostname !== "t.me" || dateLink.pathname.toLowerCase() !== `/${input.username}/${input.id}`) return
  const body = posts.find(".tgme_widget_message_text").first()
  body.find("script,style,template,.tg-spoiler").remove()
  body.find("br").replaceWith(" ")
  const desc = text(body.text(), 1200)
  const photo = posts.find(".tgme_widget_message_photo_wrap").first()
  const photoLink = publicUrl(photo.attr("href"))
  const url = publicUrl(/background-image:\s*url\(['"](https:\/\/[^'"]+)['"]\)/u.exec(photo.attr("style") ?? "")?.[1])
  const image = photoLink?.hostname === "t.me" && photoLink.pathname.toLowerCase() === dateLink.pathname.toLowerCase() &&
    url?.protocol === "https:" && /^cdn\d{1,2}\.telesco\.pe$/u.test(url.hostname) && url.pathname.startsWith("/file/") ? url : undefined
  const photoCover = await cover(fetcher, image, signal)
  if (!desc && !photoCover) return
  return { title: "Telegram 公开消息", owner, desc, cover: photoCover }
}

export async function getOfficialLink(input: OfficialLink, fetcher: OfficialLinkFetch, signal: AbortSignal): Promise<PublicPreview | undefined> {
  if (input.platform === "v2ex") {
    const endpoint = new URL("https://www.v2ex.com/api/topics/show.json")
    endpoint.searchParams.set("id", input.id)
    const bytes = await bounded(fetcher, endpoint, signal, "application/json", 256 * 1024)
    const items: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (!Array.isArray(items) || items.length !== 1) return
    const topic = items[0]
    const link = typeof topic?.url === "string" && parseOfficialLink(topic.url)
    if (!topic || !Number.isSafeInteger(topic.id) || String(topic.id) !== input.id ||
        !link || link.platform !== "v2ex" || link.id !== input.id) return
    const title = text(topic.title, 300)
    const author = text(topic.member?.username, 100)
    const node = text(topic.node?.title, 70)
    if (!title || !author) return
    const content = typeof topic.content === "string" ? topic.content.replace(/^ {0,3}(?:`{3,}|~{3,})[^\r\n]*\r?$/gmu, "") : ""
    const body = text(content, 1201)
    const chars = Array.from(body)
    return { title, owner: [author, node].filter(Boolean).join(" · "),
      desc: chars.length > 1200 ? chars.slice(0, 1200).join("") + "…" : body }
  }
  if (input.platform === "x") return xPreview(input, url => bounded(fetcher, url, signal, "application/json", 32 * 1024), publicUrl, text)
  return input.platform === "telegram" ? telegram(input, fetcher, signal) : youtube(input, fetcher, signal)
}
