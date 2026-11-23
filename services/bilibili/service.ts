import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import QRCode from "qrcode"
import YAML from "yaml"
import { resolveData, rootPath } from "../../core/path.ts"
import { formatLocalIso } from "../../core/time.ts"
import { TuneWeaveService, type TuneWeaveConfig } from "../tuneweave/service.ts"
import { downloadRanges } from "../media/range-download.ts"
import { createMediaTask, releaseMediaTask, recoverMediaTasks } from "../media/tasks.ts"
import { packMediaFiles, runMediaProcess, mediaLimitFailure, safeMediaName } from "../media/files.ts"

type VideoId = ({ bvid: string; aid?: string } | { bvid?: string; aid: string }) & { page?: number }
type BilibiliTarget = (VideoId & { type: "video" }) | { type: "live"; roomId: string }
type BilibiliInput = string | BilibiliTarget

interface TuneWeaveVideo {
  id: string
  ref: string
  title?: string
  description?: string
  cover_url?: string
  creators?: { name: string; ref?: string; resource_ref?: string }[]
  duration_ms?: number
  published_at?: string
  play_count?: number
  extensions?: {
    bvid?: string
    aid?: string | number
    ctime?: number | string
    category_name?: string
    category_name_v2?: string
    copyright?: string
    like_count?: number
    coin_count?: number
    favorite_count?: number
    danmaku_count?: number
    comment_count?: number
    share_count?: number
    first_cid?: string | number
  }
}

interface TuneWeavePart {
  video_ref: string
  id: string
  page: number
  title?: string
  duration_ms?: number
}

interface TuneWeaveTrack {
  url: string
  backup_urls?: string[]
}

interface TuneWeavePlayback {
  video_ref: string
  part_ref: string
  headers?: Record<string, string>
  video_tracks?: (TuneWeaveTrack & { id: number; codec_id?: number })[]
  audio_tracks?: (TuneWeaveTrack & { bandwidth: number })[]
  progressive_segments?: (TuneWeaveTrack & { order: number })[]
}

interface TuneWeaveQr {
  transaction_id: string
  url: string
  image_data_url?: string
}

interface TuneWeaveQrResult {
  state: string
  profile?: TuneWeaveBiliProfile
}

interface TuneWeaveBiliProfile {
  authenticated?: boolean
  platform?: string
  account?: string
  user_id?: string
}

interface LiveRoomResponse {
  code: number
  message?: string
  data?: {
    title?: string
    user_cover?: string
    keyframe?: string
    uname?: string
    live_status?: number
    online?: number
    area_name?: string
    parent_area_name?: string
  }
}

interface BilibiliAccount {
  cookie?: string
  tuneweave_account?: string
  saved_at?: string
  user_id?: string
  source?: string
}

type StoredAccount = { cookie?: string | null; tuneweave_account?: string | null; saved_at?: string; user_id?: string }

interface PreviewStats {
  view?: number
  like?: number
  coin?: number
  favorite?: number
  danmaku?: number
  reply?: number
  share?: number
}

interface VideoPreview {
  title: string
  owner?: string
  url?: string
  bvid?: string
  ownerId?: string
  duration: number
  createdAt?: number | string
  publishedAt?: string
  category?: string
  categoryV2?: string
  copyright?: string
  stat?: PreviewStats
  desc?: string
  description?: string
}

interface VideoPage {
  index: number
  page: number
  cid?: string
  partId?: string
  part?: string
  duration?: number
}

interface VideoInfo extends VideoPreview {
  type: "video"
  ref: string
  url: string
  cover: string
  owner: string
  aid?: string | number
  cid?: string | number
  pages: VideoPage[]
  selectedPage?: VideoPage
  desc: string
  description: string
  stat: PreviewStats & { bandwidth?: number }
}

interface LiveInfo {
  type: "live"
  title: string
  roomId: string
  url: string
  playerUrl: string
  cover: string
  owner: string
  liveStatus: string
  online: number
  desc: string
}

export interface BilibiliSearchResult {
  title: string
  ref: string
  bvid: string
  author: string
  play?: number
  duration: number
  url: string
}

type MultiPagePolicy = "zip" | "all" | "first"

export interface BilibiliDownloadConfig {
  enable: boolean
  concurrency: number
  tools_path: string
  resolution: number
  duration_limit_seconds: number
  video_size_limit_mb: number
  max_estimated_size_mb: number
  multi_page_policy: MultiPagePolicy
  timeout_ms: number
}

type DownloadConfigInput = Partial<Record<keyof BilibiliDownloadConfig, unknown>> & { download?: DownloadConfigInput }

interface DownloadPlan {
  ok: true
  info: VideoInfo
  pages: VideoPage[]
  policy: MultiPagePolicy
  downloader: "tuneweave-js"
  estimatedSizeMb: number
}

type DownloadFailure =
  | { ok: false; reason: "live_download_unsupported"; info: LiveInfo }
  | { ok: false; reason: "duration_limit"; info: VideoInfo; limitSeconds: number }
  | { ok: false; reason: "estimated_size_limit"; info: VideoInfo; estimatedSizeMb: number; limitMb: number }

interface DownloadSuccess extends DownloadPlan {
  taskDir: string
  taskId: string
  files: string[]
  fileNames: Record<string, string>
}

interface DownloadEvent {
  type: "download-start" | "download-part"
  message: string
}

interface DownloadHooks {
  signal?: AbortSignal
  onEvent?: (event: DownloadEvent) => void | Promise<void>
}

interface BilibiliOptions {
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>
  tuneweave?: Pick<TuneWeaveService, "config" | "request">
  tuneweaveConfig?: Partial<TuneWeaveConfig>
  tuneAccount?: string
  searchLimit?: number | string
  now?: () => Date
  accountFile?: string
  legacyAccountFiles?: readonly string[]
  tasksDir?: string
  spawn?: typeof spawn
}

interface QrOptions {
  qrcodeKey?: string
  timeoutMs?: number
  pollMs?: number
  signal?: AbortSignal
}

const BILI_SHORT_HOSTS = new Set(["b23.tv", "bili2233.cn"])
const BILI_HOSTS = new Set(["bilibili.com", "www.bilibili.com", "m.bilibili.com", "live.bilibili.com", ...BILI_SHORT_HOSTS])
const dynamicLinkInText = /(?<=^|[\s\p{Ps}\p{Pi}"'：，、；])https?:\/\/(?:t\.bilibili\.com\/|(?:www|m)\.bilibili\.com\/opus\/|m\.bilibili\.com\/dynamic\/)[1-9]\d{0,21}\/?(?=$|[\s\p{Pe}\p{Pf}"'。，、！？；：,!?;?#]|\.(?=\s|$))/iu
const LIVE_INFO_API = "https://api.live.bilibili.com/room/v1/Room/get_info"
const bareB23InText = /(?<=^|[\s\p{Ps}\p{Pi}"'：，、；])(?:\/\/)?b23\.tv\/([a-z0-9]+)(?=$|[\s\p{Pe}\p{Pf}"'。，、！？；：,!?;?#]|\.(?=\s|$))/iu
const bareB23Target = /^(?:\/\/)?b23\.tv\/([a-z0-9]+)(?:[?#]\S*)?$/iu
const legacyAccountFiles = ["Lotus-Plugin", "Lotus-ReFactor"].map(name =>
  path.join(rootPath, "plugins", name, "data", "bilibili", "account.yaml"))

const COMMON_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  Referer: "https://www.bilibili.com/",
})


export class BilibiliService {
  readonly fetch: NonNullable<BilibiliOptions["fetch"]>
  readonly tuneweave: Pick<TuneWeaveService, "config" | "request">
  tuneAccount: string
  readonly searchLimit: number
  readonly now: () => Date
  readonly accountFile: string
  readonly legacyAccountFiles: readonly string[]
  readonly tasksDir: string
  readonly spawn: typeof spawn
  private pendingAlias?: string
  private selection?: Promise<{ alias: string; record?: StoredAccount }>
  private refreshed = false

  constructor(options: BilibiliOptions = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.tuneweave = options.tuneweave || new TuneWeaveService({ config: options.tuneweaveConfig, fetch: this.fetch })
    this.tuneAccount = options.tuneAccount || ""
    this.searchLimit = Number(options.searchLimit || 10)
    this.now = options.now || (() => new Date())
    this.accountFile = options.accountFile || resolveData("bilibili", "account.yaml")
    this.legacyAccountFiles = options.legacyAccountFiles ?? (options.accountFile ? [] : legacyAccountFiles)
    this.tasksDir = options.tasksDir || resolveData("bilibili", "tasks")
    this.spawn = options.spawn || spawn
  }

  extractTarget(message = "") {
    const raw = String(message || "")
    let sawCard = false
    for (const line of raw.split(/\r?\n/)) {
      const fromCard = extractFromJsonCard(line)
      if (fromCard) return fromCard
      sawCard ||= fromCard === null
    }
    if (sawCard) return null
    const wholeCard = extractFromJsonCard(raw)
    if (wholeCard !== undefined) return wholeCard

    const clean = raw.replace(/\\\//g, "/")
    const match = clean.match(/https?:\/\/(?:www\.|m\.)?(?:bilibili\.com\/video\/[^"'\s,\]}]+|b23\.tv\/[^"'\s,\]}]+|bili2233\.cn\/[^"'\s,\]}]+|live\.bilibili\.com\/\d+)|\bBV[1-9A-Za-z]{10}\b|\bav\d+\b/i)
    const bare = bareB23InText.exec(clean)
    const dynamic = dynamicLinkInText.exec(clean)
    const first = [match, bare, dynamic].filter(candidate => candidate !== null)
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))[0]
    if (first && first === bare) return "https://b23.tv/" + bare[1]
    return first && first === match ? first[0].replace(/[）。！？；，、!?)】》]+$/u, "") : first?.[0] || ""
  }

  async resolveTarget(input = "", signal?: AbortSignal): Promise<BilibiliTarget> {
    const text = String(input || "").trim()
    if (!text) throw new Error("empty bilibili target")
    if (/^BV[1-9A-Za-z]{10}$/i.test(text)) return { type: "video", bvid: "BV" + text.slice(2) }
    if (/^av0*[1-9]\d{0,19}$/i.test(text)) return { type: "video", aid: text.slice(2).replace(/^0+/u, "") }
    const bare = bareB23Target.exec(text)
    const parsed = parseBiliUrl(bare ? "https://b23.tv/" + bare[1] : text)
    if (!parsed) throw new Error("不支持的 B 站链接")
    const url = await this.resolveShortLink(parsed, signal)
    const destination = url.href
    const live = destination.match(/live\.bilibili\.com\/(\d+)/i)
    if (live?.[1]) return { type: "live", roomId: live[1] }
    if (!isBiliVideoPage(url)) throw new Error("不支持的 B 站链接")
    const [, , token] = url.pathname.split("/")
    const page = biliPartNumber(url)
    if (page === null) throw new Error("B 站分 P 编号无效")
    const picked = page === undefined ? {} : { page }
    if (token?.slice(0, 2).toLowerCase() === "bv") return { type: "video", bvid: "BV" + token.slice(2), ...picked }
    return { type: "video", aid: token!.slice(2), ...picked }
  }

  async resolveShortLink(url: URL, active?: AbortSignal): Promise<URL> {
    const timeout = AbortSignal.timeout(15000)
    const signal = active ? AbortSignal.any([active, timeout]) : timeout
    for (let hops = 0; hops <= 5; hops++) {
      if (!BILI_SHORT_HOSTS.has(url.hostname)) return url
      const response = await this.fetch(url, { method: "HEAD", redirect: "manual", credentials: "omit", headers: COMMON_HEADERS, signal })
      if (response.status < 300 || response.status >= 400) break
      const location = response.headers.get("location")
      const next = location && parseBiliUrl(new URL(location, url))
      if (!next) break
      url = next
    }
    throw new Error("B 站短链接未跳转至可识别的地址")
  }

  async getInfo(input: BilibiliInput, signal?: AbortSignal): Promise<VideoInfo | LiveInfo> {
    const target = typeof input === "string" ? await this.resolveTarget(input, signal) : input
    if (target.type === "live") return this.getLiveInfo(target.roomId)
    return this.getVideoInfo(target, signal)
  }

  private async sameSelection(alias: string, record: StoredAccount | undefined, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (!record) return this.tuneAccount === alias
    const current = await this.loadAccount()
    signal?.throwIfAborted()
    return current?.tuneweave_account === alias && current.saved_at === record.saved_at && current.user_id === record.user_id
  }

  private selectedLogin() {
    return this.selection ??= this.loadAccount().then(stored => {
      const alias = this.tuneAccount || stored?.tuneweave_account || ""
      return { alias, record: alias && stored?.tuneweave_account === alias ? stored : undefined }
    })
  }

  async hasReusableLogin(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    const { alias, record } = await this.selectedLogin()
    if (!alias || !record) return false
    try {
      const profile = await this.tuneRequest<TuneWeaveBiliProfile>("/v1/auth/session", { platform: "bilibili" }, signal)
      if (!await this.sameSelection(alias, record, signal)) throw new Error("B 站原账号已变更，请重试。")
      if (profile?.platform !== "bilibili" || profile.account !== alias) throw new Error("TuneWeave 未确认原 B 站账号。")
      if (profile.authenticated === false) {
        if (!record.user_id || this.refreshed) return false
        return await this.refreshLogin(alias, record, signal)
      }
      if (profile.authenticated !== true || !profile.user_id || !/^[1-9]\d{0,19}$/u.test(profile.user_id) ||
          record.user_id && record.user_id !== profile.user_id) throw new Error("TuneWeave 未确认原 B 站账号。")
      return true
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "authentication_required") return false
      throw error
    }
  }

  private async refreshLogin(alias: string, record: StoredAccount, signal?: AbortSignal): Promise<boolean> {
    const originalUid = record.user_id
    if (typeof originalUid !== "string" || !/^[1-9]\d{0,19}$/u.test(originalUid)) return false
    if (!await this.sameSelection(alias, record, signal)) throw new Error("B 站原账号已变更，请重试。")
    this.refreshed = true
    const { data, accountSelected } = await this.tuneweave.request<TuneWeaveBiliProfile>(
      "/v1/auth/session/refresh", { method: "POST", signal, redirect: "error",
        accountSelection: { platform: "bilibili", alias },
        body: { platform: "bilibili", account: alias, credential_mode: "server" } })
    if (!await this.sameSelection(alias, record, signal)) throw new Error("B 站原账号已变更，请重试。")
    if (!accountSelected || data?.platform !== "bilibili" || data.account !== alias ||
        data.authenticated === true && data.user_id !== originalUid) throw new Error("TuneWeave 未确认原 B 站账号续期。")
    return data.authenticated === true
  }

  async tuneRequest<Data>(route: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<Data> {
    const { alias, record } = await this.selectedLogin()
    const query = new URLSearchParams({ ...params, ...(alias ? { account: alias } : {}) })
    const endpoint = route + (query.size ? "?" + query : "")
    if (!alias) return this.tuneweave.request<Data>(endpoint, { signal, redirect: "error" })
    const accountSelection = { platform: "bilibili", alias }
    const verify = async () => {
      if (!await this.sameSelection(alias, record, signal)) throw new Error("B 站原账号已变更，请重试。")
    }
    const read = async () => {
      await verify()
      const result = await this.tuneweave.request<Data>(endpoint, { signal, redirect: "error", accountSelection })
      await verify()
      if (!result.accountSelected) throw new Error("TuneWeave 未确认原 B 站账号。")
      return result.data
    }
    try { return await read() }
    catch (error) {
      if (!record || this.refreshed || !(error && typeof error === "object" && "code" in error && error.code === "authentication_required")) throw error
      if (!await this.refreshLogin(alias, record, signal)) {
        throw Object.assign(new Error("B 站原账号已失效，请重新扫码登录。"), { code: "authentication_required" })
      }
      return read()
    }
  }

  async getVideoInfo(target: VideoId, signal?: AbortSignal): Promise<VideoInfo> {
    const ref = target.bvid ? `bilibili:bvid:${target.bvid}` : `bilibili:aid:${target.aid}`
    const route = `/v1/videos/${encodeURIComponent(ref)}`
    const detail = await this.tuneRequest<{ video?: TuneWeaveVideo }>(route, { kind: "video" }, signal)
    const data = detail?.video
    if (!data?.ref) throw new Error("TuneWeave 视频详情不完整")
    const ext = data.extensions || {}
    const pages: TuneWeavePart[] = []
    const bvid = ext.bvid || target.bvid
    const resolvedRef = bvid ? `bilibili:bvid:${bvid}` : ref
    if (bvid && !/^BV[1-9A-Za-z]{10}$/u.test(bvid) || target.bvid && bvid !== target.bvid ||
        target.aid && String(ext.aid) !== target.aid || data.ref !== resolvedRef) {
      throw new Error("TuneWeave 视频编号与请求不匹配")
    }
    for (let offset = 0; offset < 10000; offset += 100) {
      const part = await this.tuneRequest<TuneWeavePart[]>(route + "/parts", { kind: "video", limit: "100", offset: String(offset) }, signal)
      pages.push(...part)
      if (part.length < 100) break
      if (offset === 9900) throw new Error("视频分P数量超过限制")
    }
    const parsedPages = parseParts(pages, data.ref)
    const selected = target.page === undefined ? undefined : parsedPages.find(item => item.page === target.page)
    if (target.page !== undefined && !selected) throw new Error("TuneWeave 未返回指定分 P")
    const description = stripHtml(data.description)
    const ownerRef = data.creators?.[0]?.ref ?? data.creators?.[0]?.resource_ref
    return {
      type: "video",
      ref: data.ref,
      title: selected?.part ? `${stripHtml(data.title)} · P${selected.page} ${selected.part}` : stripHtml(data.title),
      bvid,
      aid: ext.aid || target.aid,
      url: `https://www.bilibili.com/video/${bvid || "av" + target.aid}${selected ? "?p=" + selected.page : ""}`,
      cover: normalizeBiliImage(data.cover_url || ""),
      owner: data.creators?.map(c => c.name).join(" / ") || "",
      ownerId: typeof ownerRef === "string" ? /^bilibili:user:([1-9]\d*)$/u.exec(ownerRef)?.[1] : undefined,
      duration: selected?.duration ?? Number(data.duration_ms || 0) / 1000,
      createdAt: ext.ctime,
      publishedAt: data.published_at,
      category: ext.category_name,
      categoryV2: ext.category_name_v2,
      copyright: ext.copyright,
      stat: {
        view: data.play_count,
        like: ext.like_count,
        coin: ext.coin_count,
        favorite: ext.favorite_count,
        danmaku: ext.danmaku_count,
        reply: ext.comment_count,
        share: ext.share_count,
      },
      cid: selected?.cid ?? ext.first_cid,
      pages: parsedPages,
      ...(selected && { selectedPage: selected }),
      desc: description.slice(0, 180),
      description,
    }
  }

  async getLiveInfo(roomId: string | number): Promise<LiveInfo> {
    const json = await this.requestJson(`${LIVE_INFO_API}?room_id=${encodeURIComponent(roomId)}`)
    if (json.code !== 0) throw new Error(json.message || `B站直播接口错误 ${json.code}`)
    const data = json.data || {}
    return {
      type: "live",
      title: stripHtml(data.title || `直播间 ${roomId}`),
      roomId: String(roomId),
      url: `https://live.bilibili.com/${roomId}`,
      playerUrl: livePlayerUrl(roomId),
      cover: normalizeBiliImage(data.user_cover || data.keyframe || ""),
      owner: data.uname || "",
      liveStatus: data.live_status === 1 ? "直播中" : "未开播",
      online: data.online || 0,
      desc: data.area_name ? `${data.parent_area_name || ""} · ${data.area_name}` : "",
    }
  }

  async search(keyword: string, { page = 1, limit = this.searchLimit, signal }: { page?: number; limit?: number; signal?: AbortSignal } = {}): Promise<BilibiliSearchResult[]> {
    const items = await this.tuneRequest<{ type: string; data: TuneWeaveVideo }[]>("/v1/search", {
      platform: "bilibili", type: "video", q: keyword, limit: String(limit), offset: String((page - 1) * limit),
    }, signal)
    return items.filter(item => item.type === "video").map(({ data }) => {
      const bvid = data.extensions?.bvid || data.id.replace(/^bvid:/, "")
      return {
        title: stripHtml(data.title), ref: data.ref, bvid, author: data.creators?.map(c => c.name).join(" / ") || "",
        play: data.play_count, duration: Number(data.duration_ms || 0) / 1000, url: `https://www.bilibili.com/video/${bvid}`,
      }
    })
  }

  async buildDownloadPlan(input: BilibiliInput, config: DownloadConfigInput = {}, signal?: AbortSignal): Promise<DownloadPlan | DownloadFailure> {
    const info = await this.getInfo(input, signal)
    if (info.type !== "video") {
      return {
        ok: false,
        reason: "live_download_unsupported",
        info,
      }
    }

    const download = normalizeDownloadConfig(config)
    const limitFailure = mediaLimitFailure(info, download)
    if (limitFailure) return limitFailure

    const estimatedSizeMb = estimateVideoSizeMb(info)
    if (download.max_estimated_size_mb > 0 && estimatedSizeMb > download.max_estimated_size_mb) {
      return {
        ok: false,
        reason: "estimated_size_limit",
        info,
        estimatedSizeMb,
        limitMb: download.max_estimated_size_mb,
      }
    }

    const pages = info.selectedPage ? [info.selectedPage] : selectPages(info.pages, download.multi_page_policy)
    return {
      ok: true,
      info,
      pages,
      policy: download.multi_page_policy,
      downloader: "tuneweave-js",
      estimatedSizeMb,
    }
  }

  async download(input: BilibiliInput, config: DownloadConfigInput = {}, hooks: DownloadHooks = {}): Promise<DownloadSuccess | DownloadFailure> {
    const download = normalizeDownloadConfig(config)
    const plan = await this.buildDownloadPlan(input, download, hooks.signal)
    if (!plan.ok) return plan
    const task = await createMediaTask(this.tasksDir)
    try {
      await emitBiliEvent(hooks, { type: "download-start", message: `开始下载 ${plan.info.bvid}，分P策略：${plan.policy}。` })
      let files = await this.downloadWithTuneWeave(plan, download, task.dir, hooks)
      if (download.multi_page_policy === "zip" && files.length > 1) {
        const target = path.join(task.dir, `${safeFileName(plan.info.title || plan.info.bvid)}-${plan.info.bvid}.zip`)
        await packMediaFiles(files, target, { timeoutMs: download.timeout_ms, spawnImpl: this.spawn, cwd: task.dir })
        files = [target]
      }
      const fileNames = Object.fromEntries(files.map((file, index) => {
        const ext = path.extname(file)
        if (ext === ".zip") return [file, path.basename(file)]
        const pageNumber = Number(path.basename(file).match(/-P(\d+)-/)?.[1]) || plan.pages[index]?.page || index + 1
        const page = plan.pages.find(item => Number(item.page) === pageNumber)
        const title = files.length > 1 ? page?.part || plan.info.title : plan.info.title || plan.info.bvid
        return [file, `${files.length > 1 ? `P${pageNumber} ` : ""}${safeFileName(title)}${ext}`]
      }))
      return { ...plan, ok: true, taskDir: task.dir, taskId: task.id, files, fileNames }
    } catch (error) {
      await releaseMediaTask(this.tasksDir, task.dir).catch(cleanupError => {
        const { logger } = globalThis as typeof globalThis & { logger?: { warn?: (message: string) => void } }
        logger?.warn?.(`[media] B 站任务清理失败： ${cleanupError.message}`)
      })
      throw error
    }
  }

  async downloadWithTuneWeave(plan: DownloadPlan, download: BilibiliDownloadConfig, workDir: string, hooks: DownloadHooks = {}): Promise<string[]> {
    const ffmpeg = await resolveCommandPath("ffmpeg", download.tools_path)
    if (!ffmpeg) throw new Error("未找到 FFmpeg，请先初始化工具环境")
    const files: string[] = []
    const signal = hooks.signal
    const processOptions = { cwd: workDir, spawnImpl: this.spawn, timeoutMs: download.timeout_ms, signal }
    for (const page of plan.pages) {
      if (!/^\d+$/.test(String(page.cid)) || !Number.isSafeInteger(page.page) || page.page < 1) {
        throw new Error("TuneWeave 视频分 P 编号无效")
      }
      const manifest = await this.tuneRequest<TuneWeavePlayback>(`/v1/videos/${encodeURIComponent(plan.info.ref)}/playback`,
        { kind: "video", part: page.partId || "cid:" + page.cid }, signal)
      if (manifest.video_ref !== plan.info.ref || manifest.part_ref !== "bilibili:cid:" + page.cid) {
        throw new Error("TuneWeave 播放来源与所选分 P 不匹配")
      }
      const stem = `video-${plan.info.bvid || "av" + plan.info.aid}-P${page.page}-${page.cid}`, output = path.join(workDir, stem + ".mp4")
      const options = { fetch: this.fetch, headers: manifest.headers || {}, timeoutMs: download.timeout_ms, maxBytes: download.max_estimated_size_mb > 0 ? download.max_estimated_size_mb * 1024 * 1024 : 0, concurrency: download.concurrency, signal }
      await emitBiliEvent(hooks, { type: "download-part", message: `正在下载 P${page.page}，JS 并发 ${download.concurrency}。` })
      if (manifest.video_tracks?.length) {
        const videos = [...manifest.video_tracks].sort((a, b) => b.id - a.id || Number(a.codec_id !== 7) - Number(b.codec_id !== 7))
        const video = videos.find(t => t.id <= download.resolution) ?? videos[videos.length - 1]!
        const audio = [...(manifest.audio_tracks || [])].sort((a, b) => b.bandwidth - a.bandwidth)[0]
        const videoFile = path.join(workDir, stem + ".video"), audioFile = path.join(workDir, stem + ".audio")
        const operations = [downloadRanges([video.url, ...(video.backup_urls || [])], videoFile, options)]
        if (audio) operations.push(downloadRanges([audio.url, ...(audio.backup_urls || [])], audioFile, options))
        const downloads = await Promise.allSettled(operations)
        const failure = downloads.find(r => r.status === "rejected")
        if (failure) throw failure.reason
        await runMediaProcess(ffmpeg, ["-nostdin", "-y", "-i", videoFile, ...(audio ? ["-i", audioFile] : []), "-map", "0:v:0", ...(audio ? ["-map", "1:a:0"] : []), "-c", "copy", "-movflags", "+faststart", output], processOptions)
        await fs.rm(videoFile, { force: true })
        await fs.rm(audioFile, { force: true })
      } else if (manifest.progressive_segments?.length) {
        const segments = [...manifest.progressive_segments].sort((a, b) => a.order - b.order), paths = []
        for (const segment of segments) {
          const file = path.join(workDir, stem + "-segment-" + segment.order)
          await downloadRanges([segment.url, ...(segment.backup_urls || [])], file, options)
          paths.push(file)
        }
        const list = path.join(workDir, stem + ".concat")
        await fs.writeFile(list, paths.map(file => "file '" + path.basename(file) + "'").join("\n"))
        await runMediaProcess(ffmpeg, ["-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output], processOptions)
        await Promise.all([...paths, list].map(file => fs.rm(file, { force: true })))
      } else throw new Error("TuneWeave 未返回可下载视频流")
      if (!(await fs.stat(output)).size) throw new Error("合流结果为空")
      files.push(output)
    }
    return files
  }

  async recoverTasks() {
    return recoverMediaTasks(this.tasksDir)
  }

  async releaseTask(result?: Pick<DownloadSuccess, "taskDir">) {
    return releaseMediaTask(this.tasksDir, result?.taskDir ?? "")
  }

  async createQrLogin({ signal }: { signal?: AbortSignal } = {}) {
    this.pendingAlias = "lotus-bilibili"
    const qr = await this.tuneweave.request<TuneWeaveQr>("/v1/auth/qr", {
      method: "POST", body: { platform: "bilibili", account: this.pendingAlias, credential_mode: "server" },
      signal, redirect: "error",
    })
    if (!qr.transaction_id || !qr.url) throw new Error("B站二维码创建失败")
    return { url: qr.url, qrcodeKey: qr.transaction_id, qrDataUrl: qr.image_data_url || await QRCode.toDataURL(qr.url) }
  }

  async waitQrLogin({ qrcodeKey, timeoutMs = 180000, pollMs = 3000, signal }: QrOptions = {}) {
    if (!qrcodeKey) throw new Error("B站二维码事务缺失")
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const result = await this.tuneweave.request<TuneWeaveQrResult>(`/v1/auth/qr/${encodeURIComponent(qrcodeKey)}`, { signal, redirect: "error" })
      if (result.state === "confirmed") {
        const alias = this.pendingAlias || "lotus-bilibili"
        const profile = result.profile
        if (!profile?.authenticated || (profile.platform && profile.platform !== "bilibili") ||
            (profile.account && profile.account !== alias)) throw new Error("B站登录身份未核实")
        const account = { tuneweave_account: alias, saved_at: formatLocalIso(this.now()), source: "tuneweave",
          ...(typeof profile.user_id === "string" && /^[1-9]\d{0,19}$/u.test(profile.user_id) && { user_id: profile.user_id }) }
        await this.saveAccount(account, { signal })
        this.tuneAccount = account.tuneweave_account
        this.selection = undefined
        this.refreshed = false
        return { ok: true as const, account }
      }
      if (["expired", "failed", "verification_required"].includes(result.state)) throw new Error("B站二维码已过期或需要附加验证，请重新登录")
      await delay(pollMs, undefined, { signal })
    }
    throw new Error("B站二维码登录超时")
  }

  async loadAccount() {
    const current = await readAccountFile(this.accountFile)
    if (current) return configuredAccount(current)
    if (!this.legacyAccountFiles.length) return null
    const snapshots = await Promise.allSettled(this.legacyAccountFiles.map(readAccountFile))
    const saved = await readAccountFile(this.accountFile)
    if (saved) return configuredAccount(saved)
    if (snapshots.some(snapshot => snapshot.status === "rejected")) {
      throw new Error("无法读取旧 B 站账号记录，请从当前部署重新登录。")
    }
    const previous = snapshots.flatMap(snapshot => {
      const account = snapshot.status === "fulfilled" && configuredAccount(snapshot.value)
      return account ? [account] : []
    })
    const first = previous[0]
    if (first && previous.some(account => !sameAccount(first, account))) {
      throw new Error("两处旧 B 站账号记录不一致，请从当前部署重新登录。")
    }
    return first ?? null
  }

  async saveAccount(account: BilibiliAccount = {}, { signal }: { signal?: AbortSignal } = {}) {
    if (!account.cookie && !account.tuneweave_account) throw new Error("B站账号登录信息为空")
    signal?.throwIfAborted()
    await fs.mkdir(path.dirname(this.accountFile), { recursive: true, mode: 0o700 })
    const data = YAML.stringify({
      ...(account.cookie ? { cookie: normalizeBiliCookie(account.cookie) } : {}),
      ...(account.tuneweave_account ? { tuneweave_account: account.tuneweave_account } : {}),
      ...(account.user_id && { user_id: account.user_id }),
      saved_at: account.saved_at || formatLocalIso(this.now()),
      source: account.source || "manual",
    })
    const temporary = `${this.accountFile}.${randomUUID()}.tmp`
    const output = await fs.open(temporary, "wx", 0o600)
    try {
      try {
        await output.writeFile(data, "utf8")
        await output.sync()
      } finally {
        await output.close()
      }
      signal?.throwIfAborted()
      await fs.rename(temporary, this.accountFile)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    return this.accountFile
  }

  async requestJson(url: string): Promise<LiveRoomResponse> {
    if (typeof this.fetch !== "function") throw new Error("fetch is unavailable")
    const headers = { ...COMMON_HEADERS }
    const response = await this.fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15000) })
    const text = await response.text()
    const json = text ? JSON.parse(text) as LiveRoomResponse : null
    if (!response.ok) throw new Error(`B站请求失败 HTTP ${response.status}`)
    if (!json) throw new Error("B站直播接口返回无效响应")
    return json
  }
}

function configuredAccount(data?: StoredAccount) {
  return data?.cookie || data?.tuneweave_account ? data : null
}

function sameAccount(left: StoredAccount, right: StoredAccount) {
  if (left.tuneweave_account || right.tuneweave_account) return left.tuneweave_account === right.tuneweave_account
  return left.cookie === right.cookie
}

async function readAccountFile(file: string): Promise<StoredAccount | undefined> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if (error?.code !== "ENOENT") throw error
  })
  if (!handle) return
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("B站账号记录格式无效")
    const data: unknown = YAML.parse(await handle.readFile("utf8")) ?? {}
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        ("cookie" in data && data.cookie != null && typeof data.cookie !== "string") ||
        ("tuneweave_account" in data && data.tuneweave_account != null && typeof data.tuneweave_account !== "string")) {
      throw new Error("B站账号记录格式无效")
    }
    return data
  } catch {
    throw new Error("B站账号记录格式无效")
  } finally {
    await handle.close()
  }
}

export function normalizeBiliCookie(value = "") {
  const text = String(value || "").trim()
  if (!text) return ""
  if (text.includes("=")) return text
  return `SESSDATA=${text}`
}

type CookieHeaders = Partial<Pick<Headers, "getSetCookie" | "get">>

export function extractLoginCookie(data: { url?: string } = {}, headers: CookieHeaders | null = null) {
  const fromHeader = readSetCookie(headers)
  if (fromHeader) return fromHeader

  const url = String(data.url || "")
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : url
  const params = new URLSearchParams(query)
  const keys = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"]
  const pairs = []
  for (const key of keys) {
    const value = params.get(key)
    if (value) pairs.push(`${key}=${value}`)
  }
  return pairs.join("; ")
}

export function buildBilibiliItems(info: LiveInfo | (Omit<VideoInfo, "pages"> & { pages?: VideoPage[] | number })) {
  if (info.type === "live") {
    return [
      { label: "类型", value: "直播" },
      { label: "主播", value: info.owner || "未知" },
      { label: "状态", value: info.liveStatus },
      { label: "热度", value: formatNumber(info.online) },
      { label: "链接", value: info.url },
      { label: "播放器", value: info.playerUrl || livePlayerUrl(info.roomId) },
    ]
  }
  return [
    { label: "类型", value: "视频" },
    { label: "UP", value: info.owner || "未知" },
    { label: "时长", value: formatDuration(info.duration) },
    { label: "播放", value: formatNumber(info.stat?.view || 0) },
    { label: "分P", value: String(Array.isArray(info.pages) ? info.pages.length : info.pages || 1) },
    { label: "链接", value: info.url },
  ]
}

const previewTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
})

function formatPreviewTime(value: string | number | undefined) {
  const date = new Date(typeof value === "number" && value > 0 ? value * 1000 : typeof value === "string" ? value : NaN)
  if (Number.isFinite(date.getTime())) return previewTime.format(date).replace(/^(\d+)\/(\d+)\/(\d+)/u, "$1年$2月$3日")
}

export function formatBilibiliPreviewText(info: VideoPreview) {
  const category = info.categoryV2 && info.category && info.categoryV2 !== info.category
    ? `${info.categoryV2} (${info.category})` : info.categoryV2 || info.category
  const seconds = Math.floor(info.duration)
  const duration = Number.isFinite(seconds) && seconds > 0
    ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : ""
  const copyright = info.copyright === "original" ? "原创" : info.copyright === "repost" ? "转载" : undefined
  const characters = Array.from(info.description || info.desc || "")
  const description = characters.length > 2000 ? characters.slice(0, 2000).join("") + "..." : characters.join("")
  const statistics = (groups: [keyof PreviewStats, string][]) => groups.map(([key, label]) => {
    const value = info.stat?.[key]
    return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? formatNumber(value) + label : ""
  }).filter(Boolean).join(" • ")
  const fields = [
    ["bvid", info.bvid], ["分区", category], ["投稿", formatPreviewTime(info.createdAt)], ["发布", formatPreviewTime(info.publishedAt)],
    ["时长", duration], ["创作", copyright], ["UP主", info.owner], ["UID", info.ownerId], ["视频简介", description && "\n" + description],
  ]
  return [info.title, ...fields.filter(([,value])=>value).map(([label,value])=>label+"："+value),
    statistics([["view","播放"],["danmaku","弹幕"],["reply","评论"]]),
    statistics([["like","点赞"],["coin","投币"],["favorite","收藏"]]),
    statistics([["share","分享"]]), info.url && `链接：${info.url}`,
  ].filter(Boolean).join("\n")
}

export function formatNumber(value?: string | number) {
  const number = Number(value || 0)
  if (number >= 10000) return `${(number / 10000).toFixed(1)}万`
  return String(number)
}

export function formatDuration(seconds?: string | number) {
  const value = Number(seconds || 0)
  const minutes = Math.floor(value / 60)
  const rest = String(value % 60).padStart(2, "0")
  return `${minutes}:${rest}`
}

export function normalizeDownloadConfig(config: DownloadConfigInput = {}): BilibiliDownloadConfig {
  const source = config.download || config
  const policy = source.multi_page_policy
  return {
    enable: source.enable !== false,
    concurrency: Math.max(1, Math.min(16, Math.floor(Number(source.concurrency) || 4))),
    tools_path: String(source.tools_path || "data/tools/bin"),
    resolution: Number(source.resolution || 64),
    duration_limit_seconds: Number(source.duration_limit_seconds || 3600),
    video_size_limit_mb: Number(source.video_size_limit_mb || 100),
    max_estimated_size_mb: Number(source.max_estimated_size_mb || 0),
    multi_page_policy: policy === "all" || policy === "first" ? policy : "zip",
    timeout_ms: Number(source.timeout_ms || 600000),
  }
}

export function buildToolProcessEnv(pathDirs: readonly string[] = [], baseEnv = process.env) {
  const env = { ...baseEnv }
  const pathKey = Object.prototype.hasOwnProperty.call(env, "Path") ? "Path" : "PATH"
  const existingPath = env[pathKey] || ""
  const dirs = [...new Set(pathDirs
    .map(dir => String(dir || "").trim())
    .filter(Boolean)
    .map(dir => path.resolve(dir)))]
  env[pathKey] = [...dirs, existingPath].filter(Boolean).join(path.delimiter)
  return env
}

export async function resolveCommandPath(command: string, toolsPath = "") {
  const exe = process.platform === "win32" && !/\.exe$/i.test(command) ? `${command}.exe` : command
  if (toolsPath) {
    const candidate = path.join(resolveToolsPath(toolsPath), exe)
    if (await exists(candidate)) return candidate
  }

  const lookup = process.platform === "win32" ? "where.exe" : "which"
  const result = await runSpawn(lookup, [command], {
    timeoutMs: 5000,
    rejectOnNonZero: false,
  }).catch(() => null)
  const first = result?.stdout?.split(/\r?\n/).map(line => line.trim()).find(Boolean)
  return first || ""
}

function parseParts(rows: readonly TuneWeavePart[], ref: string): VideoPage[] {
  const seenPages = new Set<number>(), seenCids = new Set<string>()
  return rows.map((part, index) => {
    const cid = /^cid:([1-9]\d{0,19})$/u.exec(part.id)?.[1]
    const { page } = part
    if (!cid || !Number.isSafeInteger(page) || page < 1 || part.video_ref !== ref || seenPages.has(page) || seenCids.has(cid)) {
      throw new Error("TuneWeave 返回不匹配或重复的 B 站分 P")
    }
    seenPages.add(page)
    seenCids.add(cid)
    return { index: index + 1, cid, partId: part.id, page, part: stripHtml(part.title), duration: Number(part.duration_ms || 0) / 1000 }
  })
}

export function selectPages(pages: VideoPage[] = [], policy: MultiPagePolicy = "zip"): VideoPage[] {
  const list = Array.isArray(pages) && pages.length ? pages : [{ index: 1, page: 1 }]
  return policy === "first" ? [list[0]!] : list
}

export function safeFileName(value = "bilibili") {
  return safeMediaName(value || "bilibili")
}

function parseBiliUrl(input: string | URL) {
  const url = URL.parse(input)
  if (!url || !["https:", "http:"].includes(url.protocol) || (!BILI_HOSTS.has(url.hostname) && !biliDynamicId(url)) ||
      url.username || url.password || url.port) return
  url.protocol = "https:"
  return url
}

export function biliDynamicId(url: URL) {
  const { hostname, pathname } = url
  if (hostname === "t.bilibili.com") return /^\/([1-9]\d{0,21})\/?$/u.exec(pathname)?.[1]
  if (hostname === "www.bilibili.com" || hostname === "m.bilibili.com") {
    return /^\/opus\/([1-9]\d{0,21})\/?$/u.exec(pathname)?.[1] ??
      (hostname === "m.bilibili.com" ? /^\/dynamic\/([1-9]\d{0,21})\/?$/u.exec(pathname)?.[1] : undefined)
  }
}

export function isBiliVideoPage(url: URL) {
  return (url.hostname === "www.bilibili.com" || url.hostname === "bilibili.com" || url.hostname === "m.bilibili.com") &&
    /^\/video\/(?:BV[1-9A-Za-z]{10}|av[1-9]\d*)\/?$/iu.test(url.pathname)
}

function biliPartNumber(url: URL) {
  const values = url.searchParams.getAll("p")
  if (!values.length) return
  const [value] = values
  return values.length === 1 && value && /^[1-9]\d{0,3}$/u.test(value) ? Number(value) : null
}

function cardProperty(value: unknown, name: string): unknown {
  if (value && typeof value === "object" && Object.hasOwn(value, name)) {
    return (value as Record<string, unknown>)[name]
  }
}

export function quotedBiliCardLink(raw: unknown) {
  let card = cardProperty(raw, "data") ?? raw
  if (typeof card === "string") {
    if (card.length > 32_768) return
    try {
      card = JSON.parse(card)
    } catch {
      return
    }
  }
  const meta = cardProperty(card, "meta")
  const candidates = [cardProperty(cardProperty(meta, "detail_1"), "qqdocurl"), cardProperty(cardProperty(meta, "news"), "jumpUrl")]
  for (const value of candidates) {
    if (typeof value !== "string" || value.length > 4096) continue
    const url = parseBiliUrl(value)
    if (!url || (!isBiliVideoPage(url) && !biliDynamicId(url) &&
        !(BILI_SHORT_HOSTS.has(url.hostname) && /^\/[a-z0-9]+\/?$/iu.test(url.pathname)))) continue
    const page = isBiliVideoPage(url) ? biliPartNumber(url) : undefined
    if (page === null) return
    url.search = page === undefined ? "" : "p=" + page
    url.hash = ""
    return url.href
  }
}

function extractFromJsonCard(raw: string) {
  const trimmed = String(raw || "").trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  const jsonText = trimmed.slice(start, end + 1)
    .replace(/&#44;/g, ",")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&amp;/g, "&")
  let card: unknown
  try {
    card = JSON.parse(jsonText)
  } catch {
    return undefined
  }
  const candidates: string[] = []
  collectUrls(card, candidates)
  return candidates.find(value => parseBiliUrl(value)) || null
}

function collectUrls(value: unknown, out: string[]) {
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (["preview", "icon"].includes(key)) continue
    if (typeof child === "string" && /^https?:\/\//i.test(child)) out.push(child.replace(/\\\//g, "/"))
    else if (child && typeof child === "object") collectUrls(child, out)
  }
}

function stripHtml(value = "") {
  return String(value || "").replace(/<[^>]*>/g, "").trim()
}

function normalizeBiliImage(value = "") {
  const text = String(value || "").trim()
  if (!text) return ""
  const withProtocol = text.startsWith("//") ? `https:${text}` : text
  return withProtocol.replace(/@[^/?#]+(?=$|[?#])/i, "")
}

async function emitBiliEvent(hooks: DownloadHooks, event: DownloadEvent) {
  if (typeof hooks.onEvent === "function") {
    await hooks.onEvent(event)
  }
}

function estimateVideoSizeMb(info: VideoInfo) {
  const bandwidth = Number(info.stat?.bandwidth || 0)
  if (!bandwidth || !info.duration) return 0
  return Math.round((bandwidth * info.duration) / 8 / 1024 / 1024)
}

function resolveToolsPath(value = "") {
  const text = String(value || "")
  if (!text) return ""
  if (path.isAbsolute(text)) return text
  if (text === "data/tools/bin") return resolveData("tools", "bin")
  if (text.startsWith("data/") || text.startsWith("data\\")) return resolveData(text.slice(5))
  return path.resolve(rootPath, text)
}


interface SpawnOptions {
  spawnImpl?: typeof spawn
  cwd?: string
  pathDirs?: string[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  rejectOnNonZero?: boolean
}

interface SpawnResult {
  ok: boolean
  stdout: string
  stderr: string
  code?: number | null
  timedOut?: boolean
  error?: Error
}

function runSpawn(command: string, args: string[] = [], options: SpawnOptions = {}) {
  return new Promise<SpawnResult>((resolve, reject) => {
    const spawnImpl = options.spawnImpl || spawn
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      env: options.pathDirs ? buildToolProcessEnv(options.pathDirs, options.env || process.env) : options.env,
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, Number(options.timeoutMs || 600000))

    child.stdout?.on("data", chunk => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString()
    })
    child.on("error", error => {
      clearTimeout(timer)
      if (options.rejectOnNonZero === false) resolve({ ok: false, stdout, stderr, error })
      else reject(error)
    })
    child.on("close", code => {
      clearTimeout(timer)
      const ok = code === 0 && !timedOut
      const result = { ok, code, timedOut, stdout, stderr }
      if (ok || options.rejectOnNonZero === false) resolve(result)
      else reject(new Error(stderr || stdout || `${command} exited with code ${code}`))
    })
  })
}

async function exists(file: string) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}


function readSetCookie(headers: CookieHeaders | null) {
  if (!headers) return ""
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : []
  const raw = values.length ? values.join("; ") : headers.get?.("set-cookie") || ""
  if (!raw) return ""
  const skip = new Set(["path", "expires", "max-age", "domain", "httponly", "secure", "samesite"])
  const pairs = new Map<string, string>()
  for (const part of raw.split(/,(?=\s*[^;,=]+=[^;,]+)/)) {
    for (const item of part.split(";")) {
      const [key, ...rest] = item.trim().split("=")
      if (!key || !rest.length || skip.has(key.toLowerCase())) continue
      pairs.set(key, rest.join("="))
    }
  }
  return [...pairs.entries()].map(([key, value]) => `${key}=${value}`).join("; ")
}

function livePlayerUrl(roomId: string | number) {
  return `https://www.bilibili.com/blackboard/live/live-activity-player.html?cid=${encodeURIComponent(String(roomId || ""))}`
}
