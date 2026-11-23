import type { MessageReply } from "../../../../lib/messages.ts"
import { officialVideoGames, type OfficialVideoGame } from "./settings.ts"

interface OfficialVideo {
  readonly game: OfficialVideoGame
  readonly id: string
  readonly published: number
  readonly title: string
  readonly text: string
  readonly url: string
  readonly quality: string
  readonly size?: number
  readonly cover?: URL
}

const api = "https://bbs-api.miyoushe.com/post/wapi/userPost"
const covers = new Set(["upload-bbs.miyoushe.com", "upload-bbs.mihoyo.com"])
const date = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
const maxCover = 4 * 1024 * 1024
const maxResponse = 4 * 1024 * 1024

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function externalUrl(value: unknown) {
  const url = typeof value === "string" && value.length <= 2048 ? URL.parse(value) : undefined
  if (url?.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash) return url
}

function clean(value: unknown, limit = 3000) {
  return typeof value === "string" ? Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim()).slice(0, limit).join("") : ""
}

function content(value: unknown) {
  if (typeof value !== "string" || value.length > 150_000) return ""
  try {
    const rows: unknown = JSON.parse(value)
    return Array.isArray(rows) ? clean(rows.map(row => typeof record(row).insert === "string" ? record(row).insert : "").join("")) : ""
  } catch { return "" }
}

async function readBounded(response: Response, limit: number) {
  if (!response.ok || response.redirected || Number(response.headers.get("content-length")) > limit || !response.body) {
    await response.body?.cancel()
    throw new Error("米游社响应不可用。")
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const bytes of response.body) {
    size += bytes.length
    if (size > limit) throw new Error("米游社响应超过大小限制。")
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

export function createOfficialVideoFeed(request: typeof fetch = fetch, now = Date.now) {
  async function fetchGame(game: OfficialVideoGame, signal: AbortSignal): Promise<OfficialVideo | undefined> {
    const page = new URL(api)
    page.search = new URLSearchParams({ size: "20", uid: officialVideoGames[game].uid }).toString()
    const raw = record(JSON.parse((await readBounded(await request(page, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      redirect: "error", credentials: "omit", headers: { Accept: "application/json" } }), maxResponse)).toString("utf8")))
    const rows = record(raw.data).list
    if (raw.retcode !== 0 || !Array.isArray(rows)) throw new Error("米游社官号没有返回正常的视频列表。")
    const video: OfficialVideo[] = []
    for (const item of rows.slice(0, 20)) {
      const row = record(item)
      const post = record(row.post)
      const id = String(post.post_id ?? "")
      const published = Number(post.created_at)
      if (!/^[1-9]\d{0,17}$/u.test(id) || !Number.isSafeInteger(published) || published < 1 || published * 1000 > now() + 300_000) continue
      if (!Array.isArray(row.vod_list)) continue
      const resolutions = record(row.vod_list[0]).resolutions
      if (!Array.isArray(resolutions)) continue
      const chosen = resolutions.findLast(item => externalUrl(record(item).url))
      if (!chosen) continue
      const resolution = record(chosen)
      const url = externalUrl(resolution.url)
      if (!url) continue
      const cover = externalUrl(post.cover)
      const size = Number(resolution.size)
      video.push({ game, id, published, title: clean(post.subject, 160) || "官方视频", text: content(post.structured_content),
        url: url.href, quality: clean(resolution.label, 24), size: Number.isSafeInteger(size) && size > 0 ? size : undefined,
        cover: cover && covers.has(cover.hostname) ? cover : undefined })
    }
    return video.sort((a, b) => b.published - a.published)[0]
  }

  async function messages(video: OfficialVideo, originalCover: boolean, signal: AbortSignal): Promise<readonly MessageReply[]> {
    const game = officialVideoGames[video.game].name
    const header = [
      `游戏：${game}`, `标题：${video.title}`, `发布时间：${date.format(new Date(video.published * 1000))}`,
      `画质大小：${[video.quality, video.size && `约 ${Math.ceil(video.size / 1024 / 1024)} MB`].filter(Boolean).join(" · ") || "未提供"}`,
    ].join("\n")
    let picture: Uint8Array | undefined
    if (video.cover) {
      try {
        const url = new URL(video.cover)
        if (!originalCover) url.searchParams.set("x-oss-process", "image/resize,p_30")
        const response = await request(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), redirect: "error", credentials: "omit" })
        if (/^image\/(?:png|jpeg|webp)(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) picture = await readBounded(response, maxCover)
        else await response.body?.cancel()
      } catch { /* Keep the available metadata if the cover service is offline. */ }
    }
    signal.throwIfAborted()
    const link = `\n视频链接：${video.url}`
    const short = Array.from(video.text).length < 600
    const first: MessageReply = [header, ...(picture ? ["\n封面：\n", { type: "image" as const, file: picture }] : []), link,
      ...(short && video.text ? [`\n文本内容：\n${video.text}`] : [])]
    return short ? [first] : [first, `${game}文本内容：\n${video.text}`]
  }

  return { fetchGame, messages }
}
