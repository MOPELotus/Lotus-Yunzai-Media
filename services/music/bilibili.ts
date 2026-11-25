import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import type { TuneWeaveService } from "../tuneweave/service.ts"
import type { MusicStream, MusicTrack } from "./service.ts"

type VideoApi = Pick<TuneWeaveService, "request">

interface Video {
  platform?: string
  ref?: string
  id?: string
  title?: string
  cover_url?: string
  duration_ms?: number
  creators?: { name?: string }[]
  extensions?: { bvid?: string; first_cid?: number | string; paid?: boolean; pay?: boolean; ugc_pay?: boolean }
}

interface AudioStream {
  video_ref?: string
  part_ref?: string
  platform?: string
  available?: boolean
  mime_type?: string
  codec?: string
  duration_ms?: number
  source_range?: unknown
  trial?: unknown
  fee?: unknown
  url?: string
  backup_urls?: string[]
  headers?: Record<string, string>
  extensions?: { source?: string }
}

const bvidPattern = /^BV[1-9A-Za-z]{10}$/u
const cidPattern = /^bilibili:cid:([1-9]\d{0,19})$/u
const text = (value: unknown) => typeof value === "string" ? value.replace(/<\/?em\b[^>]*>/giu, "").trim() : ""

export function isBilibiliAudioCdn(url: URL, partRef?: string) {
  const cid = cidPattern.exec(partRef ?? "")?.[1]
  return Boolean(cid && url.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash &&
    /\.(?:bilivideo\.com|bilivideo\.cn)$/u.test(url.hostname) &&
    new RegExp(`/${cid}/${cid}(?:_[A-Za-z0-9-]+)?\\.(?:m4s|m4a)$`, "u").test(url.pathname))
}

export async function searchBilibiliAudio(api: VideoApi, keyword: string, limit: number, offset: number, signal?: AbortSignal): Promise<MusicTrack[]> {
  const query = new URLSearchParams({ platform: "bilibili", type: "video", q: keyword, limit: String(limit), offset: String(offset) })
  const results = await api.request<{ type: string; data?: Video }[]>(`/v1/search?${query}`, { signal, redirect: "error" })
  if (!Array.isArray(results)) throw new Error($t("services.music.bilibili.text_af247c2432"))
  return results.flatMap(({ type, data }) => {
    const bvid = data?.extensions?.bvid
    if (type !== "video" || !bvid || !bvidPattern.test(bvid) || data.platform !== "bilibili" ||
        data.id !== `bvid:${bvid}` || data.ref !== `bilibili:bvid:${bvid}` || data.extensions?.paid === true) return []
    const name = text(data.title)
    if (!name) return []
    const artists = Array.isArray(data.creators) ? data.creators.map(creator => ({ name: text(creator.name) })).filter(creator => creator.name) : []
    return [{ platform: "bilibili", ref: data.ref, id: bvid, name, artists,
      extensions: { url: `https://www.bilibili.com/video/${bvid}`, video_cover_url: data.cover_url, video_duration_ms: data.duration_ms } }] satisfies MusicTrack[]
  })
}

export async function resolveBilibiliAudio(api: VideoApi, track: MusicTrack, signal?: AbortSignal): Promise<MusicStream> {
  const bvid = String(track.id)
  const unavailable = () => new Error($t("services.music.bilibili.text_085eee8870"))
  if (!bvidPattern.test(bvid) || track.ref !== `bilibili:bvid:${bvid}`) throw unavailable()
  const route = `/v1/videos/${encodeURIComponent(track.ref)}`
  const request = { signal, redirect: "error" } as const
  const detail = await api.request<{ kind?: string; video?: Video }>(`${route}?kind=video`, request)
  const video = detail?.video
  if (detail?.kind !== "video" || video?.ref !== track.ref || video.platform !== "bilibili" ||
      video.id !== `bvid:${bvid}` || video.extensions?.bvid !== bvid || video.extensions.paid === true ||
      video.extensions.pay === true || video.extensions.ugc_pay === true) throw unavailable()
  const parts = await api.request<{ ref?: string; video_ref?: string; platform?: string; id?: string; page?: number;
    duration_ms?: number; extensions?: { bvid?: string; cid?: number | string } }[]>(`${route}/parts?kind=video&limit=1&offset=0`, request)
  const part = Array.isArray(parts) ? parts[0] : undefined
  const cid = cidPattern.exec(part?.ref ?? "")?.[1]
  const duration = Number(part?.duration_ms)
  if (!part?.ref || !cid || part.platform !== "bilibili" || part.video_ref !== track.ref || part.id !== `cid:${cid}` ||
      part.page !== 1 || part.extensions?.bvid !== bvid || String(part.extensions.cid) !== cid ||
      String(video.extensions.first_cid) !== cid ||
      !Number.isFinite(duration) || duration <= 0) throw unavailable()
  const audio = await api.request<AudioStream>(`${route}/audio-stream?${new URLSearchParams({ kind: "video", part: part.ref, quality: "high", codec: "aac" })}`, request)
  const audioDuration = Number(audio?.duration_ms)
  if (audio?.platform !== "bilibili" || audio.video_ref !== track.ref || audio.part_ref !== part.ref || audio.available !== true ||
      audio.mime_type !== "audio/mp4" || !/^mp4a\./u.test(audio.codec ?? "") || audio.source_range != null ||
      audio.trial || audio.fee != null || audio.extensions?.source !== "video_playback_manifest" || !Number.isFinite(audioDuration) ||
      Math.abs(audioDuration - duration) > Math.max(1500, duration * 0.01)) throw unavailable()
  const mediaUrl = (value: string) => {
    const url = URL.parse(value)
    if (url && isBilibiliAudioCdn(url, part.ref)) return url.href
  }
  const urls = [audio.url ?? "", ...(Array.isArray(audio.backup_urls) ? audio.backup_urls : [])].map(mediaUrl)
    .filter((value): value is string => Boolean(value))
  const [url, ...backup_urls] = urls
  if (!url) throw unavailable()
  const userAgent = audio.headers?.["User-Agent"]
  const headers = { Referer: `https://www.bilibili.com/video/${bvid}`,
    ...(typeof userAgent === "string" && /^Mozilla\/5\.0[\x20-\x7e]{0,500}$/u.test(userAgent) ? { "User-Agent": userAgent } : {}) }
  return { url, backup_urls, headers, duration_ms: Math.max(duration, audioDuration), bilibili_part_ref: part.ref,
    resolved_platform: "bilibili", origin_track: track.ref, resolved_track: track.ref }
}
