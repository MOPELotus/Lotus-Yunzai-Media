import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { readPublicResponse } from "../public-read.ts"
export type ExternalMusicShare = {
  readonly platform: "apple" | "spotify"
  readonly kind: "external-share"
  readonly id: string
  readonly url: string
  readonly region?: string
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
    throw new Error($t("services.music.external-share.text_eaa0c2d34d"))
  }
  const decoder = new TextDecoder()
  let size = 0
  let body = ""
  for await (const chunk of response.body) {
    signal.throwIfAborted()
    size += chunk.byteLength
    if (size > limit) throw new Error($t("services.music.external-share.text_970eeeff1f"))
    body += decoder.decode(chunk, { stream: true })
  }
  return body + decoder.decode()
}

const request = (url: URL, signal: AbortSignal, fetch: typeof globalThis.fetch) =>
  readPublicResponse((target, init) => fetch(new URL(target), init), url, { signal, credentials: "omit", redirect: "error", headers: { "User-Agent": "Mozilla/5.0" } })

export const externalMusicLabels = { apple: "Apple Music", spotify: "Spotify" } as const

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
  }
  throw new Error($t("services.music.external-share.text_6c81748cdc"))
}
