export type ExternalMusicShare = {
  readonly platform: "apple" | "spotify" | "soda" | "bodian"
  readonly kind: "external-share"
  readonly id: string
  readonly url: string
  readonly region?: string
  readonly video?: boolean
}

const numericId = /^[1-9]\d{0,19}$/u
const spotifyId = /^[A-Za-z0-9]{22}$/u

function parameter(url: URL, key: string) {
  const values = url.searchParams.getAll(key)
  return values.length === 1 ? values[0] : undefined
}

export function parseExternalMusicShare(url: URL): ExternalMusicShare | undefined {
  const path = url.pathname.replace(/\/$/u, "")
  if (url.hostname === "music.apple.com") {
    const parts = /^\/([a-z]{2})\/(album|song)(?:\/[^/]+)?\/([1-9]\d{0,19})$/u.exec(path)
    if (!parts) return
    const id = parts[2] === "song" && !url.searchParams.has("i") ? parts[3] : parameter(url, "i")
    if (!id || !numericId.test(id) || parts[2] === "song" && parts[3] !== id) return
    return { kind: "external-share", platform: "apple", id, region: parts[1], url: "https://music.apple.com" + path +
      (parts[2] === "album" ? "?i=" + id : "") }
  }
  if (url.hostname === "open.spotify.com") {
    const id = /^\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})$/u.exec(path)?.[1]
    if (id && spotifyId.test(id)) return { kind: "external-share", platform: "spotify", id, url: "https://open.spotify.com/track/" + id }
  }
  if (url.hostname === "qishui.douyin.com" && /^\/s\/[A-Za-z0-9]{4,24}$/u.test(path)) {
    return { kind: "external-share", platform: "soda", id: "", url: "https://qishui.douyin.com" + path + "/" }
  }
  if (url.hostname === "music.douyin.com" && path === "/qishui/share/track") {
    const id = parameter(url, "track_id")
    if (id && numericId.test(id)) return { kind: "external-share", platform: "soda", id,
      url: "https://music.douyin.com/qishui/share/track?track_id=" + id }
  }
  if (url.hostname === "h5app.kuwo.cn") {
    const video = path === "/m/bodian/play.html"
    if (!video && path !== "/m/bodian/playMusic.html") return
    const id = parameter(url, video ? "mvId" : "musicId")
    if (id && numericId.test(id)) return { kind: "external-share", platform: "bodian", id, video,
      url: "https://h5app.kuwo.cn" + path + (video ? "?mvId=" : "?musicId=") + id }
  }
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function field(input: unknown) {
  return typeof input === "string" && input.trim().replace(/\s+/gu, " ").slice(0, 160) || undefined
}

async function boundedBody(response: Response, limit: number, signal: AbortSignal) {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel().catch(() => {})
    throw new Error("原平台分享页暂时不可用。")
  }
  const decoder = new TextDecoder()
  let size = 0
  let body = ""
  for await (const chunk of response.body) {
    signal.throwIfAborted()
    size += chunk.byteLength
    if (size > limit) throw new Error("原平台分享页超过读取限制。")
    body += decoder.decode(chunk, { stream: true })
  }
  return body + decoder.decode()
}

const request = (url: URL, signal: AbortSignal, fetch: typeof globalThis.fetch, redirect: RequestRedirect = "error") =>
  fetch(url, { signal, credentials: "omit", redirect, headers: {
    "User-Agent": url.hostname.endsWith(".douyin.com") ? "Mozilla/5.0 (Linux; Android 13)" : "Mozilla/5.0",
  } })

export const externalMusicLabels = { apple: "Apple Music", spotify: "Spotify", soda: "汽水音乐", bodian: "波点音乐" } as const

export async function readExternalMusicShare(
  share: ExternalMusicShare, signal: AbortSignal, fetch = globalThis.fetch,
): Promise<{ title: string; author?: string; url: string }> {
  const active = AbortSignal.any([signal, AbortSignal.timeout(8_000)])
  if (share.platform === "apple") {
    const lookup = new URL("https://itunes.apple.com/lookup")
    lookup.search = new URLSearchParams({ id: share.id, country: share.region?.toUpperCase() ?? "" }).toString()
    const data = record(JSON.parse(await boundedBody(await request(lookup, active, fetch), 128 * 1024, active)))
    const result = Array.isArray(data.results) && data.results.map(record).find(item => item.kind === "song" &&
      item.wrapperType === "track" && Number.isSafeInteger(item.trackId) && String(item.trackId) === share.id)
    const title = result && field(result.trackName)
    if (title && result) return { title, author: field(result.artistName), url: share.url }
  } else if (share.platform === "spotify") {
    const endpoint = new URL("https://open.spotify.com/oembed")
    endpoint.searchParams.set("url", share.url)
    const data = record(JSON.parse(await boundedBody(await request(endpoint, active, fetch), 32 * 1024, active)))
    const src = typeof data.html === "string" && /\bsrc="([^"]+)"/u.exec(data.html)?.[1]
    const embed = src ? URL.parse(src) : undefined
    const title = field(data.title)
    if (title && data.provider_name === "Spotify" && embed?.origin === "https://open.spotify.com" &&
        embed.pathname === "/embed/track/" + share.id) return { title, url: share.url }
  } else if (share.platform === "bodian") {
    const endpoint = new URL("https://bd-api.kuwo.cn/api/service/music/info")
    endpoint.search = new URLSearchParams({ musicId: share.id, uid: "-1", token: "" }).toString()
    const response = await fetch(endpoint, { signal: active, credentials: "omit", redirect: "error", headers: {
      "User-Agent": "Dart/2.18 (dart:io)", plat: "ar", ver: "3.1.0", channel: "aliopen",
      devId: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
    } })
    const data = record(JSON.parse(await boundedBody(response, 64 * 1024, active)))
    const item = record(data.data)
    const title = field(item.name)
    if (data.code === 200 && title && Number.isSafeInteger(item.id) && String(item.id) === share.id &&
        (!share.video || item.isMv === 1)) return { title, author: field(item.artist), url: share.url }
  } else {
    if (!share.id) {
      const response = await request(new URL(share.url), active, fetch, "manual")
      await response.body?.cancel().catch(() => {})
      const location = response.headers.get("Location")
      const destination = location ? URL.parse(location, share.url) : undefined
      const target = destination?.origin === "https://music.douyin.com" && !destination.username && !destination.password
        ? parseExternalMusicShare(destination) : undefined
      if (response.status < 300 || response.status >= 400 || target?.platform !== "soda" || !target.id) {
        throw new Error("汽水分享未指向可核实的单曲。")
      }
      share = target
    }
    const body = await boundedBody(await request(new URL(share.url), active, fetch), 1024 * 1024, active)
    const data = /\b_ROUTER_DATA\s*=\s*(\{[^\r\n]+\});/u.exec(body)?.[1]
    const result = data && record(record(record(record(JSON.parse(data)).loaderData).track_page).audioWithLyricsOption)
    const title = result && field(result.trackName)
    if (title && result && result.track_id === share.id) return { title, author: field(result.artistName), url: share.url }
  }
  throw new Error("原平台返回的单曲编号无法核实。")
}

export async function readQqSongMid(id: string, signal: AbortSignal, fetch = globalThis.fetch): Promise<string> {
  const url = new URL("https://y.qq.com/n/ryqq_v2/songDetail/" + id)
  const active = AbortSignal.any([signal, AbortSignal.timeout(8_000)])
  const body = await boundedBody(await request(url, active, fetch), 512 * 1024, active)
  const canonical = /<meta\s+property="og:url"\s+content="([^"]+)"\s*\/?>/iu.exec(body)?.[1]
  if (canonical !== url.href) throw new Error("QQ 音乐未返回原曲目的官方页面。")
  const matches = new Set<string>()
  for (const script of body.matchAll(/<script\b[^>]*\btype="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/giu)) {
    let graph: unknown
    try { graph = record(JSON.parse(script[1]!))["@graph"] } catch { continue }
    if (!Array.isArray(graph)) continue
    for (const item of graph.map(record)) {
      if (item["@type"] !== "MusicRecording" || typeof item.url !== "string") continue
      const mid = /^https:\/\/y\.qq\.com\/n\/ryqq(?:_v2)?\/songDetail\/([A-Za-z0-9]{14})$/u.exec(item.url)?.[1]
      if (mid) matches.add(mid)
    }
  }
  if (matches.size === 1) return [...matches][0]!
  throw new Error("QQ 音乐未返回唯一的原曲目 MID。")
}
