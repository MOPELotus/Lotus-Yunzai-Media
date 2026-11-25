import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import fs from "node:fs/promises"
import path from "node:path"
import { resolveData } from "../../core/path.ts"
import { createMediaTask, releaseMediaTask, recoverMediaTasks } from "../media/tasks.ts"
import { packMediaFiles, safeMediaName, mediaFailureMessage, mediaLimitFailure } from "../media/files.ts"
import { downloadMedia } from "../media/download.ts"
import { prepareVideo } from "../media/video.ts"
import { extractDouyinTarget, resolveDouyinShare, resolveDouyinTarget, type DouyinLiveTarget, type DouyinTarget } from "./links.ts"
import { readDouyinLive } from "./live.ts"
import { fetchWebDetail, type DetailSigner } from "./api.ts"
import { fetchSsrDetail } from "./ssr.ts"
import { DouyinVisitor, getDefaultVisitor, type VisitorSession, type VisitorRequest } from "./visitor.ts"
import { normalizeDouyinWork, selectVideoSources, type DouyinWork, type MediaSource } from "./model.ts"
import { WEB_UA } from "./signature.ts"
import { DouyinError, type DouyinFetch } from "./http.ts"

type MultiPagePolicy = "first" | "all" | "zip"
type MediaKind = "image" | "video"
type DownloadCandidate = Pick<MediaSource, "urls" | "codec">
type WorkTarget = Pick<DouyinTarget, "id"> | DouyinTarget

type VideoPreparation = (file: string, options: NonNullable<Parameters<typeof prepareVideo>[1]>) => ReturnType<typeof prepareVideo>

interface DownloadSettings {
  enable?: boolean
  tools_path?: string
  quality?: string
  duration_limit_seconds?: number
  video_size_limit_mb?: number
  max_estimated_size_mb?: number
  multi_page_policy?: string
  timeout_ms?: number
}

interface DownloadConfig extends DownloadSettings {
  download?: DownloadSettings
}

interface ServiceOptions {
  fetch?: DouyinFetch
  now?: () => number
  sign?: DetailSigner
  timeoutMs?: number
  visitor?: {
    get: (options: VisitorRequest) => Promise<string>
    getSession?: (options: VisitorRequest) => Promise<VisitorSession>
  }
  tasksDir?: string
  prepareVideo?: VideoPreparation
  pack?: typeof packMediaFiles
}

interface DownloadHooks {
  signal?: AbortSignal
  onEvent?: (event: { type: "download-start"; message: string }) => void | Promise<void>
}

interface DownloadFailure {
  index: number
  kind: MediaKind
  message: string
}

type DownloadArtifact =
  | { file: string; kind: string; sizeBytes: number; index: number }
  | { file: string; kind: "text"; index: 0 }

// A single message can stop waiting without cancelling another message's shared visitor request.
async function waitForVisitor(pending: Promise<string | VisitorSession>, signal?: AbortSignal) {
  if (!signal) return pending
  let cancel: () => void = () => {}
  try {
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason)
      if (signal.aborted) cancel()
      else signal.addEventListener("abort", cancel, { once: true })
    })
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener("abort", cancel)
  }
}

export function normalizeDouyinDownloadConfig(config: DownloadConfig = {}) {
  const source = config.download || config
  const multiPagePolicy = source.multi_page_policy
  const policy: MultiPagePolicy = multiPagePolicy === "first" || multiPagePolicy === "all" ? multiPagePolicy : "zip"
  return {
    enable: source.enable !== false, tools_path: String(source.tools_path || "data/tools/bin"),
    quality: source.quality || "adapt", duration_limit_seconds: Number(source.duration_limit_seconds ?? 3600),
    video_size_limit_mb: Number(source.video_size_limit_mb || 100), max_estimated_size_mb: Number(source.max_estimated_size_mb || 0),
    multi_page_policy: policy,
    timeout_ms: Number(source.timeout_ms || 600000),
  }
}

export class DouyinService {
  readonly fetch: DouyinFetch
  readonly now: () => number
  readonly sign: DetailSigner | undefined
  readonly timeoutMs: number
  readonly visitor: NonNullable<ServiceOptions["visitor"]>
  readonly tasksDir: string
  readonly prepareVideo: VideoPreparation
  readonly pack: typeof packMediaFiles

  constructor(options: ServiceOptions = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.now = options.now || Date.now
    this.sign = options.sign
    this.timeoutMs = options.timeoutMs || 15000
    this.visitor = options.visitor || (options.fetch || options.now ? new DouyinVisitor({ fetch: this.fetch, now: this.now, timeoutMs: this.timeoutMs }) : getDefaultVisitor())
    this.tasksDir = options.tasksDir || resolveData("douyin", "tasks")
    this.prepareVideo = options.prepareVideo || prepareVideo
    this.pack = options.pack || packMediaFiles
  }

  extractTarget(message: unknown) { return extractDouyinTarget(message) }
  resolveTarget(input: string) { return resolveDouyinTarget(input, { fetch: this.fetch, timeoutMs: this.timeoutMs }) }

  resolveShare(input: string, signal?: AbortSignal) {
    return resolveDouyinShare(input, { fetch: this.fetch, timeoutMs: this.timeoutMs, signal })
  }
  getLiveInfo(target: DouyinLiveTarget, signal?: AbortSignal) {
    return readDouyinLive(target, { fetch: this.fetch, timeoutMs: this.timeoutMs, signal })
  }

  async getInfo(input: string | WorkTarget, { deadline = Infinity, signal }: { deadline?: number; signal?: AbortSignal } = {}): Promise<DouyinWork> {
    const requestBudget = () => {
      signal?.throwIfAborted()
      const remaining = Math.min(this.timeoutMs, deadline - Date.now())
      if (remaining <= 0) throw new DouyinError("timeout", $t("services.douyin.service.text_a29911a38c"))
      return remaining
    }
    const target = typeof input === "string" ? await resolveDouyinTarget(input, { fetch: this.fetch, timeoutMs: requestBudget(), signal }) : input
    if (!/^\d+$/.test(target?.id || "")) throw new DouyinError("invalid_link", $t("services.douyin.service.text_016d9b54af"))
    let previous: string | VisitorSession = ""
    let primaryError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const getVisitor: (options: VisitorRequest) => Promise<string | VisitorSession> = this.visitor.getSession || this.visitor.get
        const pending = getVisitor.call(this.visitor, { refresh: attempt > 0, previous, timeoutMs: requestBudget() })
        previous = await waitForVisitor(pending, signal)
        const detail = await fetchWebDetail(target.id, previous, { fetch: this.fetch, timeoutMs: requestBudget(), signal, sign: this.sign, now: this.now() })
        return normalizeDouyinWork(detail, { source: "web", expectedId: target.id })
      } catch (error) {
        signal?.throwIfAborted()
        if ((error as { code?: string }).code === "unavailable" || Date.now() >= deadline) throw error
        primaryError = error
        // HTTP reads already exhausted their internal network budget. Refresh
        // visitor state only for a business/session failure, not another 3 reads.
        if (["network", "timeout", "api_http"].includes((error as { code?: string }).code ?? "")) break
      }
    }
    try {
      const detail = await fetchSsrDetail(target.id, { fetch: this.fetch, timeoutMs: requestBudget(), signal })
      return normalizeDouyinWork(detail, { source: "ssr", expectedId: target.id })
    } catch (error) {
      signal?.throwIfAborted()
      if ((error as { code?: string }).code === "unavailable") throw error
      throw new DouyinError("parse_failed", $t("services.douyin.service.text_d8804f00ee"), { cause: new AggregateError([primaryError, error]) })
    }
  }

  async download(input: string | WorkTarget | DouyinWork, config: DownloadConfig = {}, hooks: DownloadHooks = {}) {
    const { signal } = hooks
    signal?.throwIfAborted()
    const download = normalizeDouyinDownloadConfig(config)
    const info = typeof input === "object" && "platform" in input && input.platform === "douyin" ? input : await this.getInfo(input, { signal })
    signal?.throwIfAborted()
    const limitFailure = mediaLimitFailure(info, download)
    if (limitFailure) return limitFailure
    const task = await createMediaTask(this.tasksDir)
    const deadline = Date.now() + download.timeout_ms
    const files: string[] = []
    const artifacts: DownloadArtifact[] = []
    const warnings = [...info.warnings]
    const failedItems: DownloadFailure[] = []
    let consumed = 0
    let refreshed: Promise<DouyinWork> | undefined
    const remainingTime = () => {
      signal?.throwIfAborted()
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error($t("services.douyin.service.text_a29911a38c"))
      return remaining
    }
    const refreshWork = async () => {
      remainingTime()
      const fresh = await this.getInfo(info.url, { deadline, signal })
      const imageGroup = (work: DouyinWork) => work.type === "gallery" || work.type === "live_photo"
      if (fresh.id !== info.id || fresh.media.length !== info.media.length ||
          (fresh.type !== info.type && !(imageGroup(fresh) && imageGroup(info))) ||
          fresh.media.some(({ assetId, index }, position) => {
            const original = info.media[position]
            return index !== original?.index || Boolean(assetId && original.assetId && assetId !== original.assetId)
          })) {
        throw new DouyinError("media_changed", $t("services.douyin.service.text_f9d0429385"))
      }
      const limit = mediaLimitFailure(fresh, download)
      if (limit) throw new DouyinError(limit.reason, mediaFailureMessage(limit))
      return fresh
    }
    const downloadItem = async (candidates: DownloadCandidate[], base: string, kind: MediaKind) => {
      let lastError
      for (const candidate of candidates) {
        for (const url of candidate.urls) {
          try {
            const cap = download.max_estimated_size_mb * 1024 * 1024
            if (cap > 0 && consumed >= cap) throw new Error($t("services.douyin.service.text_15d06226fc"))
            const options = {
              fetch: this.fetch,
              kind,
              headers: { "User-Agent": WEB_UA, Referer: "https://www.douyin.com/" },
              timeoutMs: remainingTime(),
              maxBytes: cap > 0 ? cap - consumed : 0,
              signal,
            }
            const result = await downloadMedia(url, base, options)
            let conversionWarnings: readonly string[] = []
            if (kind === "video") {
              const prepared = await this.prepareVideo(result.file, { ...download, timeout_ms: remainingTime(), codec: candidate.codec, signal })
              if (prepared.file !== result.file) result.sizeBytes = (await fs.stat(prepared.file)).size
              result.file = prepared.file
              conversionWarnings = prepared.warnings
            }
            signal?.throwIfAborted()
            if (cap > 0 && result.sizeBytes > cap - consumed) throw new Error($t("services.douyin.service.text_15d06226fc"))
            consumed += result.sizeBytes
            warnings.push(...conversionWarnings)
            return result
          } catch (error) {
            lastError = error
            // Conversion can fail after the final file exists. This attempt is not a reusable artifact.
            for (const ext of [".mp4", ".mkv", ".flv", ".jpg", ".png", ".webp", ".gif", ".avif", ".heic", "-compatible.mp4"]) {
              await fs.rm(`${base}${ext}`, { force: true }).catch(() => {})
            }
            signal?.throwIfAborted()
          }
        }
      }
      throw lastError || new Error($t("services.douyin.service.text_eb1982d2d9"))
    }
    try {
      signal?.throwIfAborted()
      await hooks.onEvent?.({ type: "download-start", message: $t("services.douyin.service.text_4ad3bb58d0", { "id": info.id }) })
      signal?.throwIfAborted()
      if (info.article) {
        const file = path.join(task.dir, $t("services.douyin.service.text_ded590219e"))
        const text = [info.title, $t("services.douyin.service.text_4c59ffb174", { "owner": info.owner }), info.url, "", ...info.article.blocks.map(block => block.type === "text" ? block.text : $t("services.douyin.service.text_52f9cd574b", { "value1": block.urls[0] }))].join("\n\n")
        await fs.writeFile(file, text, "utf8")
        files.push(file); artifacts.push({ file, kind: "text", index: 0 })
      }
      const items = download.multi_page_policy === "first" ? info.media.slice(0, 1) : info.media
      for (const item of items) {
        const prefix = path.join(task.dir, String(item.index).padStart(3, "0"))
        const processPart = async (kind: MediaKind, candidates: DownloadCandidate[], suffix: string) => {
          try {
            let result
            try { result = await downloadItem(candidates, `${prefix}-${suffix}`, kind) } catch (firstError) {
              const fresh = await (refreshed ??= refreshWork())
              signal?.throwIfAborted()
              const replacement = fresh.media.find(entry => entry.index === item.index)
              if (!replacement) throw firstError
              result = await downloadItem(kind === "image" ? [{ urls: replacement.urls }] : selectVideoSources(replacement.sources, download), `${prefix}-${suffix}`, kind)
            }
            files.push(result.file); artifacts.push({ ...result, index: item.index })
            return true
          } catch (error) {
            signal?.throwIfAborted()
            if (error instanceof DouyinError && ["unavailable", "duration_limit", "media_changed"].includes(error.code)) throw error
            failedItems.push({ index: item.index, kind, message: error instanceof Error ? error.message : $t("services.douyin.service.text_71e60c9d14") })
            return false
          }
        }
        if (item.type === "image" || item.type === "live_photo") await processPart("image", [{ urls: item.urls }], "image")
        if (item.type === "video" || item.type === "live_photo") {
          const obtained = await processPart("video", selectVideoSources(item.sources, download), "video")
          if (!obtained && item.type === "video" && item.urls.length && await processPart("image", [{ urls: item.urls }], "image")) {
            warnings.push($t("services.douyin.service.text_aca979d378", { "index": item.index }))
          }
        }
      }
      if (!files.length) throw new Error(failedItems[0]?.message || $t("services.douyin.service.text_b14f6c8f45"))
      if (failedItems.length) warnings.push($t("services.douyin.service.text_c5f7b5c95f", { "value1": failedItems.map(item => $t("services.douyin.service.text_76765483e7", { "index": item.index, "value2": item.kind === "video" ? $t("services.douyin.service.text_c20f7618d3") : $t("services.douyin.service.text_d24c10d37d") })).join("、") }))
      let output = files
      const fileNames: Record<string, string> = {}
      if (download.multi_page_policy === "zip" && files.length > 1) {
        if (failedItems.length) await fs.writeFile(path.join(task.dir, $t("services.douyin.service.text_bb8a1b9c0c")), failedItems.map(item => $t("services.douyin.service.text_9e37cd0ab1", { "index": item.index, "kind": item.kind, "message": item.message })).join("\n"), "utf8")
        const packFiles = failedItems.length ? [...files, path.join(task.dir, $t("services.douyin.service.text_bb8a1b9c0c"))] : files
        const target = path.join(task.dir, "archive.zip")
        await this.pack(packFiles, target, { cwd: task.dir, timeoutMs: remainingTime(), signal })
        output = [target]
        fileNames[target] = `${safeMediaName(info.title)}-${info.id}.zip`
      }
      signal?.throwIfAborted()
      return { ok: true, info, taskDir: task.dir, taskId: task.id, files: output, fileNames, artifacts, warnings, partial: failedItems.length > 0, failedItems }
    } catch (error) {
      await this.releaseTask({ taskDir: task.dir }).catch(cleanupError => (globalThis as typeof globalThis & { logger?: { warn?: (message: string) => void } }).logger?.warn?.($t("services.douyin.service.text_6e14b8ac5a", { "message": cleanupError.message })))
      throw error
    }
  }

  recoverTasks() { return recoverMediaTasks(this.tasksDir) }
  releaseTask(result?: { taskDir?: string }) { return releaseMediaTask(this.tasksDir, result?.taskDir) }
}
