import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { join } from "node:path"
import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { resolveData } from "../../core/path.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import type { MediaFetch } from "../media/cdn.ts"
import { mediaDeliveryUnknown, runMediaProcess, safeMediaName, sendMediaFile } from "../media/files.ts"
import { downloadRanges } from "../media/range-download.ts"
import { createMediaTask, releaseMediaTask } from "../media/tasks.ts"
import { normalizeDownloadConfig, resolveCommandPath } from "./service.ts"
import type { BiliPgc, BiliPgcEpisode, BiliPgcFetch, BiliPgcTarget, readBiliPgcJson } from "./pgc.ts"

const endpoint = "https://api.bilibili.com/pgc/player/web/playurl"
const oldQualities = [127, 126, 125, 120, 116, 112, 80, 74, 64, 32, 16] as const
export const biliPgcDefaultDuration = 1800
export const biliPgcDefaultQuality = 32
export const biliPgcQualities = [[0, $t("services.bilibili.pgc-playback.text_017262f30c")], [16, "360P"], [32, "480P"], [64, "720P"], [74, $t("services.bilibili.pgc-playback.text_bebd810cdd")], [80, "1080P"],
  [112, $t("services.bilibili.pgc-playback.text_54ed0b548d")], [116, $t("services.bilibili.pgc-playback.text_dfb0bbbc7a")], [120, "4K"], [125, "HDR"], [126, $t("services.bilibili.pgc-playback.text_7963e073e1")], [127, "8K"]] as const

export function playbackQuality(value: unknown, legacy: unknown): number {
  if (biliPgcQualities.some(([id]) => value === id)) return Number(value)
  return typeof legacy === "number" && Number.isInteger(legacy) ? oldQualities[legacy] ?? biliPgcDefaultQuality : biliPgcDefaultQuality
}

interface PublicTrack { readonly id: number; readonly size: number; readonly md5: string; readonly urls: readonly string[] }
type Fields = Record<string, unknown>
function fields(value: unknown): Fields {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {}
}

function cdn(value: unknown, cid: string) {
  const url = typeof value === "string" && value.length <= 4096 ? URL.parse(value) : undefined
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      !url.hostname.endsWith(".bilivideo.com") || !new RegExp(`^/upgcxcode/\\d{2}/\\d{2}/${cid}/${cid}(?:_p1)?-\\d+-\\d+\\.m4s$`, "u").test(url.pathname)) return
  return url.href
}

function tracks(list: unknown, type: "video" | "audio", cid: string) {
  if (!Array.isArray(list)) return []
  return list.flatMap(raw => {
    const row = fields(raw)
    if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || !row.id ||
        typeof row.size !== "number" || !Number.isSafeInteger(row.size) || row.size <= 0 ||
        typeof row.md5 !== "string" || !/^[a-f0-9]{32}$/u.test(row.md5) ||
        row.mimeType !== `${type}/mp4` || typeof row.codecs !== "string" ||
        !(type === "video" ? row.codecid === 7 && /^avc[13]\./u.test(row.codecs) : /^mp4a\.40\./u.test(row.codecs))) return []
    const urls = [row.baseUrl, row.base_url, ...(Array.isArray(row.backupUrl) ? row.backupUrl : []),
      ...(Array.isArray(row.backup_url) ? row.backup_url : [])].flatMap(value => cdn(value, cid) ?? [])
    return urls.length ? [{ id: row.id, size: row.size, md5: row.md5, urls: [...new Set(urls)] }] : []
  })
}

export function publicBiliPgcTracks(raw: unknown, entry: BiliPgcEpisode, quality: number) {
  if (!entry.cid || !/^\d+$/u.test(entry.cid) || !entry.duration) return
  const body = fields(raw)
  const result = fields(body.result)
  if (body.code !== 0 || result.code !== 0 || result.error_code !== 0 || result.can_watch_reason !== 0 ||
      result.bp !== 0 || result.has_paid !== false || result.is_drm !== false || result.is_preview !== 0 || result.status !== 2 ||
      typeof result.timelength !== "number" || !Number.isFinite(result.timelength) ||
      Math.abs(result.timelength / 1000 - entry.duration) > 3) return
  const dash = fields(result.dash)
  const video = tracks(dash.video, "video", entry.cid).filter(row => !quality || row.id <= quality).sort((a, b) => b.id - a.id)[0]
  const audio = tracks(dash.audio, "audio", entry.cid).sort((a, b) => b.id - a.id)[0]
  if (video && audio) return { video, audio, duration: result.timelength / 1000 }
}

function eligible(data: BiliPgc, entry: BiliPgcEpisode): entry is BiliPgcEpisode & { cid: string; duration: number } {
  return !!entry.cid && !!entry.duration && entry.status === 2 && !entry.badge &&
    entry.rights.area_limit === 0 && entry.rights.allow_download === 1 &&
    data.rights.can_watch === 1 && data.rights.allow_download === 1
}

async function downloadVerifiedTrack(track: PublicTrack, path: string, request: MediaFetch, settings: ReturnType<typeof normalizeDownloadConfig>,
  referer: string, signal: AbortSignal) {
  const { sizeBytes } = await downloadRanges(track.urls, path, { timeoutMs: settings.timeout_ms, maxBytes: track.size,
    concurrency: settings.concurrency, fetch: request, headers: { Referer: referer }, signal })
  if (sizeBytes !== track.size) throw new Error($t("services.bilibili.pgc-playback.text_d49f2b5d20"))
  const md5 = createHash("md5")
  for await (const bytes of createReadStream(path, { signal })) md5.update(bytes)
  if (md5.digest("hex") !== track.md5) throw new Error($t("services.bilibili.pgc-playback.text_64abdfdd0a"))
}

export function createBiliPgcPlayback({
  fetcher = fetch, cdnFetch = fetch, load = loadGlobalConfig, taskRoot = resolveData("bilibili", "tasks"),
}: {
  readonly fetcher?: BiliPgcFetch
  readonly cdnFetch?: MediaFetch
  readonly load?: typeof loadGlobalConfig
  readonly taskRoot?: string
} = {}) {
  const running = new Set<string>()
  return async function play(target: BiliPgcTarget, data: BiliPgc, context: MessageFallbackContext, options: { quality: number; duration: number },
    signal: AbortSignal, readJson: typeof readBiliPgcJson): Promise<string | readonly [] | undefined> {
    if (signal.aborted) return
    const entry = data.episode
    const referer = entry ? `https://www.bilibili.com/bangumi/play/ep${entry.id}` : target.url
    const fail = (message: string) => message + "\n" + referer
    if (!entry || !eligible(data, entry) || (target.kind === "ep" && entry.id !== target.id)) {
      return fail($t("services.bilibili.pgc-playback.text_eb00c68dbe"))
    }
    if (entry.duration > options.duration) return fail($t("services.bilibili.pgc-playback.text_b08ae5b323"))
    const key = `${context.adapter ?? "onebot"}:${context.self_id}:${context.group_id ?? context.user_id}:${entry.id}`
    if (running.has(key)) return fail($t("services.bilibili.pgc-playback.text_03e12362ce"))
    running.add(key)
    let task: Awaited<ReturnType<typeof createMediaTask>> | undefined
    try {
      const config = await load()
      const permission = new PermissionService({ permissions: config.permissions })
      const subject = context.canManagePackages ? { ...context, isMaster: true } : context
      if (!permission.explain(subject, "bilibili.download").ok) return fail($t("services.bilibili.pgc-playback.text_777920556f"))
      const settings = normalizeDownloadConfig(config.bilibili)
      if (!settings.enable) return fail($t("services.bilibili.pgc-playback.text_8268e0a5e9"))
      if (entry.duration > settings.duration_limit_seconds) return fail($t("services.bilibili.pgc-playback.text_094a5e7354"))
      const url = new URL(endpoint)
      url.search = new URLSearchParams({ ep_id: entry.id, cid: entry.cid, qn: String(options.quality || 127), fnval: "16" }).toString()
      const media = publicBiliPgcTracks(await readJson(fetcher, url, referer, AbortSignal.any([signal, AbortSignal.timeout(8000)])),
        entry, options.quality)
      if (!media) return fail($t("services.bilibili.pgc-playback.text_0b568ac1a6"))
      if (settings.max_estimated_size_mb > 0 && media.video.size + media.audio.size > settings.max_estimated_size_mb * 1024 * 1024) {
        return fail($t("services.bilibili.pgc-playback.text_0f0bbf263c"))
      }
      const [ffmpeg, ffprobe] = await Promise.all(["ffmpeg", "ffprobe"].map(command => resolveCommandPath(command, settings.tools_path)))
      if (!ffmpeg || !ffprobe) return fail($t("services.bilibili.pgc-playback.text_4df7900132"))
      const allowed = new Set([...media.video.urls, ...media.audio.urls])
      const request: MediaFetch = async (url, options) => {
        if (!allowed.has(url)) throw new Error($t("services.bilibili.pgc-playback.text_a95e1645e4"))
        const reply = await cdnFetch(url, { ...options, credentials: "omit", redirect: "error" })
        if (reply.redirected || (reply.status === 200 && reply.headers.has("content-range")) ||
            (!new Headers(options?.headers).has("range") && (reply.status !== 200 || reply.headers.has("content-range")))) {
          await reply.body?.cancel().catch(() => undefined)
          throw new Error($t("services.bilibili.pgc-playback.text_dd9a916fc8"))
        }
        return reply
      }
      task = await createMediaTask(taskRoot)
      const process = { cwd: task.dir, timeoutMs: settings.timeout_ms, signal }
      const video = join(task.dir, "video.m4s"), audio = join(task.dir, "audio.m4s"), file = join(task.dir, "episode.mp4")
      await downloadVerifiedTrack(media.video, video, request, settings, referer, signal)
      await downloadVerifiedTrack(media.audio, audio, request, settings, referer, signal)
      await runMediaProcess(ffmpeg, ["-nostdin", "-v", "error", "-y", "-i", video, "-i", audio,
        "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", file], process)
      const report = await runMediaProcess(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration",
        "-of", "json", file], process)
      const parsed = fields(JSON.parse(report.output))
      const streams = Array.isArray(parsed.streams) ? parsed.streams.map(fields) : []
      const duration = Number(fields(parsed.format).duration)
      if (!streams.some(row => row.codec_type === "video" && row.codec_name === "h264") ||
          !streams.some(row => row.codec_type === "audio" && row.codec_name === "aac") ||
          !Number.isFinite(duration) || Math.abs(duration - media.duration) > 3) return fail($t("services.bilibili.pgc-playback.text_1ff77ec87b"))
      await sendMediaFile(context, file, { file_name: safeMediaName(`${data.title} ${entry.title} ep${entry.id}`) + ".mp4",
        video_size_limit_mb: settings.video_size_limit_mb, signal })
      return []
    } catch (error) {
      if (signal.aborted) return
      return fail(fields(error).code === mediaDeliveryUnknown ? $t("services.bilibili.pgc-playback.text_cc7be90b66") : $t("services.bilibili.pgc-playback.text_d828fa3e95"))
    } finally {
      running.delete(key)
      if (task) await releaseMediaTask(task.root, task.dir).catch(() => undefined)
    }
  }
}
