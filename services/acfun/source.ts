import { acfunImageUrl, acfunVideoUrl, fetchCdn, type MediaFetch } from "../media/cdn.ts"

const canonical = "https://www.acfun.cn"
const rawId = /^ac([1-9]\d{0,17})$/iu
const pagePath = /^\/v\/ac([1-9]\d{0,17})(?:_([1-9]\d{0,3}))?\/?$/iu
const links = /https?:\/\/(?:www\.|m\.)?acfun\.cn\/(?:(?:v\/ac[1-9]\d{0,17}(?:_[1-9]\d{0,3})?)|(?:v\/\?[^\s"'<>\\，。！？；：]+))[^\s"'<>\\，。！？；：]*/giu
const maxPlaylistTime = 3600

export interface AcfunTarget {
  readonly id: string
  readonly part?: number
}

export function exactAcfunTarget(input: string): AcfunTarget | undefined {
  if (input.length > 4096) return
  const id = rawId.exec(input)?.[1]
  if (id) return { id }
  const url = URL.parse(input)
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) return
  if (url.hostname === "www.acfun.cn" || url.hostname === "acfun.cn") {
    const match = pagePath.exec(url.pathname)
    if (match?.[1]) return { id: match[1], ...(match[2] && { part: Number(match[2]) }) }
    return
  }
  if (url.hostname !== "m.acfun.cn" || !["/v", "/v/"].includes(url.pathname)) return
  const values = url.searchParams.getAll("ac")
  const [first] = values
  if (values.length === 1 && first && /^[1-9]\d{0,17}$/u.test(first)) return { id: first }
}

export function sharedAcfunTarget(input: string) {
  const direct = exactAcfunTarget(input.trim())
  if (direct) return direct
  for (const candidate of input.matchAll(links)) {
    if (candidate.index > 0 && /[a-z0-9_./@%=?#-]/iu.test(input[candidate.index - 1]!)) continue
    const target = exactAcfunTarget(candidate[0].replaceAll("&amp;", "&").replace(/[),.;!\]}>]+$/gu, ""))
    if (target) return target
  }
}

export function acfunPage({ id, part }: AcfunTarget) {
  return `${canonical}/v/ac${id}${part === undefined ? "" : "_" + part}`
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function plain(input: unknown, max: number) {
  return typeof input === "string" ? Array.from(input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim()).slice(0, max).join("") : ""
}

function count(input: unknown) {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : undefined
}

function jsonObjectAt(source: string, offset: number): unknown {
  if (source[offset] !== "{") return
  let quoted = false, escaped = false, depth = 0
  for (let index = offset; index < source.length; index++) {
    const char = source[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === "{") depth++
    else if (char === "}" && --depth === 0) return JSON.parse(source.slice(offset, index + 1))
  }
}

async function readText(response: Response, maxBytes: number, signal: AbortSignal) {
  try {
    if (response.status !== 200 || !response.body || Number(response.headers.get("content-length")) > maxBytes) {
      throw new Error("AcFun 响应不可用或超过大小限制。")
    }
    let size = 0
    let text = ""
    const decoder = new TextDecoder()
    for await (const chunk of response.body.values()) {
      signal.throwIfAborted()
      size += chunk.byteLength
      if (size > maxBytes) throw new Error("AcFun 响应超过大小限制。")
      text += decoder.decode(chunk, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {})
  }
}

function playback(raw: unknown) {
  if (typeof raw !== "string" || raw.length > 512 * 1024) return []
  let data: Record<string, unknown>
  try { data = record(JSON.parse(raw)) } catch { return [] }
  const representations = record(Array.isArray(data.adaptationSet) ? data.adaptationSet[0] : undefined).representation
  if (!Array.isArray(representations)) return []
  return representations.slice(0, 20).flatMap(entry => {
    const { url, backupUrl, qualityLabel, width, height } = record(entry)
    const files = [url, ...(Array.isArray(backupUrl) ? backupUrl.slice(0, 3) : [])]
      .flatMap(value => typeof value === "string" && value.length <= 4096 ? [acfunVideoUrl(value)] : [])
      .filter((candidate): candidate is URL => Boolean(candidate?.pathname.endsWith(".m3u8")))
    return files.length ? [{ quality: plain(qualityLabel, 32), width: count(width), height: count(height),
      files: [...new Set(files.map(file => file.href))] }] : []
  })
}

export async function acfunInfo(target: AcfunTarget, fetch: MediaFetch, signal: AbortSignal) {
  const { id, part } = target
  const active = AbortSignal.any([signal, AbortSignal.timeout(12_000)])
  const url = acfunPage(target)
  const response = await fetch(url, { credentials: "omit", redirect: "error", signal: active,
    headers: { Accept: "text/html,application/xhtml+xml" } })
  const html = await readText(response, 2 * 1024 ** 2, active)
  const start = /(?:^|[>;\s])window\.pageInfo\s*=\s*window\.videoInfo\s*=\s*(?=\{)/u.exec(html)
  if (!start) throw new Error("AcFun 未返回公开作品。")
  const data = record(jsonObjectAt(html, start.index + start[0].length))
  const title = plain(data.title, 180)
  if (String(data.dougaId) !== id || !title) throw new Error("AcFun 未返回匹配的公开作品。")
  const current = record(data.currentVideoInfo)
  if (part !== undefined) {
    const expected = record(Array.isArray(data.videoList) ? data.videoList[part - 1] : undefined)
    const videoId = String(current.id ?? "")
    if (!/^[1-9]\d{0,17}$/u.test(videoId) || String(expected.id) !== videoId || String(data.currentVideoId) !== videoId ||
        current.priority !== part - 1) throw new Error("AcFun 未返回指定分段。")
  }
  const partTitle = part === undefined ? "" : plain(current.title, 100)
  const cover = typeof data.coverUrl === "string" && data.coverUrl.length <= 4096 ? acfunImageUrl(data.coverUrl)?.href : undefined
  return { id, part, url, title: partTitle ? title + " · " + partTitle : title, owner: plain(record(data.user).name, 80), desc: plain(data.description, 900), cover,
    duration: (count(current.durationMillis) ?? count(data.durationMillis) ?? 0) / 1000, createdAt: (count(data.createTimeMillis) ?? 0) / 1000,
    stat: { view: count(data.viewCount), like: count(data.likeCount), reply: count(data.commentCountRealValue),
      favorite: count(data.stowCount), danmaku: count(data.danmakuCount), coin: count(data.bananaCount) },
    sources: playback(current.ksPlayJson),
  }
}

const allowedTags = /^#(?:EXT-X-(?:VERSION|TARGETDURATION|MEDIA-SEQUENCE):\d+|EXT-X-PLAYLIST-TYPE:VOD|EXT-X-INDEPENDENT-SEGMENTS|EXT-X-KEY:METHOD=NONE)$/u

export async function acfunPlaylist(value: string, fetch: MediaFetch, signal: AbortSignal) {
  const active = AbortSignal.any([signal, AbortSignal.timeout(12_000)])
  const response = await fetchCdn(fetch, value, { signal: active }, "acfun-video")
  const body = await readText(response, 256 * 1024, active)
  const rows = body.trim().split(/\r?\n/u).map(row => row.trim()).filter(Boolean)
  if (rows[0] !== "#EXTM3U" || rows.at(-1) !== "#EXT-X-ENDLIST") throw new Error("AcFun 视频未返回完整的点播清单。")
  const finalUrl = acfunVideoUrl(response.url || value)
  if (!finalUrl?.pathname.endsWith(".m3u8")) throw new Error("AcFun 点播清单地址无效。")
  const segments: string[] = []
  let duration = 0, hasDuration = false
  for (const line of rows.slice(1, -1)) {
    const tag = /^#EXTINF:(\d+(?:\.\d+)?),.*$/u.exec(line)
    if (tag && !hasDuration) {
      const length = Number(tag[1])
      duration += length
      if (!length || duration > maxPlaylistTime) throw new Error("AcFun 视频超出时长限制。")
      hasDuration = true
    } else if (allowedTags.test(line) && !hasDuration) continue
    else {
      const address = !line.startsWith("#") && line.length <= 4096 ? URL.parse(line, finalUrl) : undefined
      const segment = address && acfunVideoUrl(address)
      if (!hasDuration || !segment?.pathname.endsWith(".ts") || segments.length >= 512) {
        throw new Error("AcFun 点播清单含有不支持的分片或加密流。")
      }
      segments.push(segment.href)
      hasDuration = false
    }
  }
  if (hasDuration || !segments.length) throw new Error("AcFun 点播清单没有完整分片。")
  return segments
}
