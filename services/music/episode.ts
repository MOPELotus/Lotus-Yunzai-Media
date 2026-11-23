import type { MusicStream, MusicTrack } from "./service.ts"

type EpisodeId = string | number
type EpisodeData = {
  readonly id?: EpisodeId
  readonly platform?: string
  readonly ref?: string
  readonly audio?: MusicTrack
  readonly creator?: { readonly name?: string }
  readonly name?: string
  readonly cover_url?: string
  readonly duration_ms?: number
  readonly paid?: boolean
}
type VoiceSearchItem = {
  readonly type?: string
  readonly data?: EpisodeData & { readonly kind?: string; readonly extensions?: { readonly response?: { readonly baseInfo?: {
    readonly id?: EpisodeId
    readonly mainSong?: { readonly id?: EpisodeId; readonly name?: string }
    readonly dj?: { readonly nickname?: string }
    readonly coverUrl?: string
    readonly duration?: number
  } } } }
}

interface EpisodeResult {
  readonly ref?: string
  readonly audio_ref?: string
  readonly stream?: MusicStream & { readonly origin_track?: string; readonly resolved_track?: string }
  readonly extensions?: { readonly episode?: EpisodeData }
}

export interface EpisodeTranscript {
  readonly ref?: string
  readonly audio_ref?: string
  readonly lyrics?: { readonly track_ref?: string; readonly plain?: string; readonly format?: string;
    readonly extensions?: { readonly available?: boolean } }
  readonly extensions?: { readonly episode?: EpisodeData }
}

const neteaseId = /^[1-9]\d{0,21}$/u
function id(value: unknown) {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) return
  const text = String(value)
  if (neteaseId.test(text)) return text
}

export function voiceSearchSelection(item: VoiceSearchItem | undefined) {
  const data = item?.data
  if (data?.platform !== "netease") return
  // beta.3's voice search preserves the provider's payload in a documented opaque item.
  const payload = item?.type === "opaque" && data.kind === "voice" ? data.extensions?.response?.baseInfo : undefined
  const episode = id(payload?.id ?? (item?.type === "podcast_episode" ? data.id : undefined))
  const audio = id(payload?.mainSong?.id ?? data.audio?.id)
  if (!episode || !audio) return
  if (data.ref != null && data.ref !== `netease:${episode}` || data.audio?.ref != null && data.audio.ref !== `netease:${audio}`) return
  return {
    id: episode, ref: `netease:${episode}`, audioRef: `netease:${audio}`, audioId: audio,
    name: payload?.mainSong?.name || data.name || "网易云播客",
    creator: payload?.dj?.nickname || data.creator?.name,
    cover: payload?.coverUrl || data.cover_url,
    duration: payload?.duration || data.duration_ms,
  }
}

export function neteaseEpisodePage(episodeId: string) {
  return `https://music.163.com/#/dj?id=${encodeURIComponent(episodeId)}`
}

export type VoiceSearchSelection = NonNullable<ReturnType<typeof voiceSearchSelection>>

export function episodeSelectionFromTrack(track: MusicTrack): VoiceSearchSelection | undefined {
  const episode = id(track.episode_id)
  const audio = id(track.id)
  if (track.platform !== "netease" || !episode || !audio || track.ref !== "netease:" + audio) return
  return { id: episode, ref: "netease:" + episode, audioRef: track.ref, audioId: audio,
    name: track.name, creator: track.artists?.[0]?.name, cover: track.album?.cover_url, duration: track.duration_ms }
}

export function verifiedEpisodePlayback(selection: VoiceSearchSelection, response: EpisodeResult | undefined): { track: MusicTrack; stream: MusicStream } {
  const episode = response?.extensions?.episode
  const stream = response?.stream
  if (response?.ref !== selection.ref || response.audio_ref !== selection.audioRef || episode?.ref !== selection.ref ||
      episode.audio?.ref !== selection.audioRef || stream?.resolved_platform !== "netease" ||
      stream.origin_track !== selection.audioRef || stream.resolved_track !== selection.audioRef ||
      typeof stream.url !== "string" || !stream.url || stream.trial) {
    throw new Error("没有可用的完整播客音源，或平台返回的节目身份不一致。")
  }
  const creator = episode.creator?.name || selection.creator
  const track: MusicTrack = {
    platform: "netease", ref: selection.audioRef, id: selection.audioId,
    name: episode.name || selection.name,
    artists: creator ? [{ name: creator }] : episode.audio?.artists,
    album: { cover_url: episode.cover_url || selection.cover },
    duration_ms: episode.duration_ms || selection.duration,
    episode_id: selection.id,
  }
  return { track, stream }
}

export function verifiedEpisodeTranscript(selection: VoiceSearchSelection, response: EpisodeTranscript | undefined) {
  const episode = response?.extensions?.episode
  const lyrics = response?.lyrics
  if (response?.ref !== selection.ref || response.audio_ref !== selection.audioRef || episode?.ref !== selection.ref ||
      episode.platform !== "netease" || id(episode.id) !== selection.id || episode.audio?.ref !== selection.audioRef ||
      episode.audio.platform !== "netease" || id(episode.audio.id) !== selection.audioId || lyrics?.track_ref !== selection.audioRef) {
    throw new Error("平台返回的播客字幕与所选节目或音轨不一致。")
  }
  if (episode.paid === true || lyrics.extensions?.available === false) return
  if (lyrics.extensions?.available !== true || lyrics.format !== "netease_voice_json" || typeof lyrics.plain !== "string") {
    throw new Error("平台返回的播客字幕无法核实。")
  }
  const text = lyrics.plain.trim()
  if (!text) return
  if (text.length > 97_000) throw new Error("播客字幕过长，请打开原节目查看。\n" + neteaseEpisodePage(selection.id))
  return text
}

export type { EpisodeData, EpisodeResult, VoiceSearchItem }
