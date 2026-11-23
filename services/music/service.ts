import type { MusicCard } from "../../../../lib/messages.ts"
import path from "node:path"
import { isIP } from "node:net"
import QRCode from "qrcode"
import { setTimeout as sleep } from "node:timers/promises"
import { TuneWeaveService, type TuneWeaveConfig, type TuneWeaveAccountSelection } from "../tuneweave/service.ts"
import { resolveQrProfile, type TuneWeaveQrProfile } from "../tuneweave/auth.ts"
import { NeteasePartnerAccounts } from "./partner-account.ts"
import { downloadRanges } from "../media/range-download.ts"
import { resolveCommandPath } from "../bilibili/service.ts"
import { createMediaTask, releaseMediaTask, recoverMediaTasks } from "../media/tasks.ts"
import { runMediaProcess } from "../media/files.ts"
import { resolveData } from "../../core/path.ts"
import { readMusicAccounts, saveMusicAccount, type MusicAccounts } from "./accounts.ts"
import { neteaseEpisodePage, verifiedEpisodePlayback, verifiedEpisodeTranscript, voiceSearchSelection, type EpisodeData,
  type EpisodeResult, type EpisodeTranscript, type VoiceSearchItem, type VoiceSearchSelection } from "./episode.ts"
import type { PublicMusicTarget } from "./share-link.ts"
import { musicVideoCdnUrl, type MusicVideoCdn } from "../media/cdn.ts"
import { isBilibiliAudioCdn, resolveBilibiliAudio, searchBilibiliAudio } from "./bilibili.ts"
import { findOwnedNeteaseAccount, musicAccountAlias, neteaseAccountId, neteaseOwnerAlias, recordedNeteaseOwner,
  verifyNeteaseAccount, verifyOrRenewNeteaseAccount } from "./netease-account.ts"
import { canRefreshPublicMusic, musicAuthenticationRequired, refreshOwnMusicAccount, refreshPublicMusicAccount } from "./personal.ts"

export const MUSIC_PLATFORMS = Object.freeze({ netease: "网易云", qq: "QQ音乐", kugou: "酷狗", kuwo: "酷我", migu: "咪咕", soda: "汽水" })
export const MUSIC_QR_TYPES = Object.freeze({ qq: [{ name: "QQ", type: "qq" }, { name: "QQ音乐", type: "mobile" }, { name: "微信", type: "wechat" }], kugou: [{ name: "酷狗音乐", type: "standard" }, { name: "酷狗概念版", type: "concept" }, { name: "网页版", type: "web" }] })
export type MusicTrack = {
  readonly platform: string
  readonly ref: string
  readonly id: string | number
  readonly name: string
  readonly artists?: readonly { readonly name: string; readonly avatar_url?: string }[]
  readonly album?: { readonly cover_url?: string }
  readonly extensions?: { readonly url?: string; readonly album_audio_id?: string | number; readonly hash?: string; readonly numeric_id?: string;
    readonly video_cover_url?: string; readonly video_duration_ms?: number }
  readonly duration_ms?: number
  readonly episode_id?: string
}

export interface MusicStream {
  url: string
  trial?: boolean | { readonly start_ms?: number; readonly end_ms?: number } | null
  resolved_platform?: string
  backup_urls?: string[]
  headers?: Record<string, string>
  duration_ms?: number
  origin_track?: string
  resolved_track?: string
  bilibili_part_ref?: string
}

type MusicMv = { readonly ref: string; readonly id: string | number; readonly platform: "netease" | "kuwo" | "qq" | "kugou"; readonly title: string;
  readonly duration_ms?: number; readonly creators?: readonly { readonly name?: string }[] }
type MusicMvStream = { readonly video_ref?: string; readonly platform?: string; readonly available?: boolean;
  readonly format?: string; readonly fee?: unknown; readonly source_range?: unknown; readonly platform_code?: unknown;
  readonly url?: string; readonly backup_urls?: readonly string[]; readonly size?: number; readonly duration_ms?: number;
  readonly extensions?: { readonly kind?: string; readonly source_track_id?: string; readonly authorization_source?: string;
    readonly selected_protocol?: string; readonly backend?: string;
    readonly selected_resource?: { readonly hash?: string; readonly pay_type?: number; readonly privilege?: number } } }

interface MusicLogin {
  platform: string
  key: string
  alias: string
  image: string
  owner?: number
}

export interface MusicConfig {
  quality: string
  search_limit: number
  download_timeout_ms: number
  max_size_mb: number
  enable?: boolean
  default_platform?: string
  session_timeout_ms?: number
}

interface MusicServiceOptions {
  tuneweave?: Pick<TuneWeaveService, "config" | "request" | "requireReady">
  tuneweaveConfig?: Partial<TuneWeaveConfig>
  config?: Partial<MusicConfig>
  toolsPath?: string
  tasksDir?: string
  fetch?: (input: Request | URL | string, init?: RequestInit) => Promise<Response>
  accountsFile?: string
  partnerAccountsFile?: string
}

type Capability = { platform: string; registered?: boolean; capabilities?: string[] }
type SearchItem = { type: string; data: MusicTrack }
type QrCode = { transaction_id?: string; url?: string; image_data_url?: string }
type QrStatus = { state: string; profile?: TuneWeaveQrProfile; caller_credential?: { value?: string } }
type ProbeResult = { format?: { duration?: string | number }; streams?: { codec_type?: string }[] }
type DownloadRequest = { headers?: Record<string, string>; signal?: AbortSignal }

export const musicSessionKey = (e: {
  readonly adapter?: "milky"
  readonly message_type: "group" | "private" | "terminal"
  readonly self_id?: number | string
  readonly group_id?: number | string
  readonly user_id?: number | string
}) => [e.adapter ?? "onebot", e.self_id, e.message_type, e.group_id, e.user_id].join(":")
export const musicLoginTimeout = (platform: string) => platform === "netease" ? 300000 : 180000
export class MusicService {
  readonly tuneweave: NonNullable<MusicServiceOptions["tuneweave"]>
  readonly config: MusicConfig
  readonly toolsPath: string
  readonly tasksDir: string
  readonly fetch: NonNullable<MusicServiceOptions["fetch"]>
  readonly accountsFile?: string
  readonly partner: NeteasePartnerAccounts

  constructor(options: MusicServiceOptions = {}) {
    this.tuneweave = options.tuneweave || new TuneWeaveService({ config: options.tuneweaveConfig })
    this.config = { quality: "standard", search_limit: 10, download_timeout_ms: 180000, max_size_mb: 128, ...options.config }
    this.toolsPath = options.toolsPath || "data/tools/bin"
    this.tasksDir = options.tasksDir || resolveData("music", "tasks")
    this.fetch = options.fetch || globalThis.fetch
    this.accountsFile = options.accountsFile
    this.partner = new NeteasePartnerAccounts(options.partnerAccountsFile)
  }
  private request<T>(route: string, accounts?: MusicAccounts, accountSelection?: undefined, signal?: AbortSignal): Promise<T>
  private request<T>(route: string, accounts: MusicAccounts, accountSelection: TuneWeaveAccountSelection, signal?: AbortSignal):
    Promise<{ data: T; accountSelected: boolean }>
  private async request<T>(route: string, accounts?: MusicAccounts, accountSelection?: TuneWeaveAccountSelection, signal?: AbortSignal) {
    accounts ??= await readMusicAccounts(this.accountsFile)
    const accountSnapshot = accounts
    return this.tuneweave.request<T>(route, { credentials: Object.values(accounts).map(a => a?.credential).filter((credential): credential is string => Boolean(credential)), accountSelection, signal,
      onCredentialUpdates: async updates => {
        await Promise.all(updates.filter(u => accountSnapshot[u.platform]?.credential).map(u =>
          saveMusicAccount(u.platform, { credential: u.credential }, { file: this.accountsFile, expected: accountSnapshot[u.platform], signal })))
      },
    })
  }
  private async usePublicAccount<T>(platform: string, accounts: MusicAccounts, signal: AbortSignal | undefined,
    request: (accounts: MusicAccounts) => Promise<T>) {
    try {
      return await request(accounts)
    } catch (error) {
      const signedIn = accounts[platform]
      if (!canRefreshPublicMusic(platform) || !musicAuthenticationRequired(error, platform) || !signedIn?.alias || !signedIn.uid ||
          !signedIn.credential?.startsWith("twc1_") && (platform !== "netease" || signedIn.credential)) throw error
      const renewalSignal = signal ?? new AbortController().signal
      const profile = await refreshPublicMusicAccount(this, platform, signedIn, renewalSignal)
      const credential = signedIn.credential ? profile.caller_credential?.value : signedIn.credential
      const current = (await readMusicAccounts(this.accountsFile))[platform]
      renewalSignal.throwIfAborted()
      if (current?.alias !== signedIn.alias || current.uid !== signedIn.uid || current.owner !== signedIn.owner ||
          current.credential !== credential) throw new Error("公共音乐账号已变更，请重新点歌。")
      return request({ ...accounts, [platform]: current })
    }
  }
  async adoptPartnerAccount() {
    if ((await readMusicAccounts(this.accountsFile)).netease) return
    const linked = (await this.partner.loadAccounts()).filter(a => a.tuneweave_account)
    const [account] = linked
    if (linked.length !== 1 || !account?.tuneweave_account || !musicAccountAlias.test(account.tuneweave_account) ||
        !neteaseAccountId.test(String(account.uid ?? ""))) return
    const owner = Number(account.qq)
    await saveMusicAccount("netease", { alias: account.tuneweave_account, uid: account.uid, nickname: account.nickname, credential: "",
      ...(Number.isSafeInteger(owner) && owner > 0 && { owner }) }, { file: this.accountsFile, expected: null })
  }
  async reuseNeteaseLogin(owner: number, signal: AbortSignal, selectPublic: boolean) {
    const currentBinding = await findOwnedNeteaseAccount(this, owner, signal)
    const oldAccounts = currentBinding ? [] : (await this.partner.loadAccounts()).filter(account =>
      !account.tuneweave_account && Boolean(account.cookie) && String(account.qq) === String(owner) &&
      neteaseAccountId.test(String(account.uid ?? "")))
    const legacy = oldAccounts.length === 1 ? oldAccounts[0] : undefined
    // The old partner used the TuneWeave default alias. It may already be
    // authenticated, so check its UID without resending the old raw cookie.
    const account = currentBinding ?? (legacy ? { owner, alias: "default", uid: String(legacy.uid) } : undefined)
    if (!account) return false
    if (legacy) {
      const music = (await readMusicAccounts(this.accountsFile)).netease
      if (music?.alias === "default" && (!recordedNeteaseOwner(music, owner) || String(music.uid) !== account.uid)) return false
    }
    let profile
    try {
      profile = legacy ? await verifyNeteaseAccount(this, account, signal) : await verifyOrRenewNeteaseAccount(this, account, signal)
    }
    catch (error) {
      if (musicAuthenticationRequired(error)) return false
      throw error
    }
    const latest = await findOwnedNeteaseAccount(this, owner, signal)
    if (currentBinding ? latest?.alias !== account.alias || latest.uid !== account.uid : Boolean(latest)) {
      throw new Error("网易云绑定已变更，请重试。")
    }
    const existing = (await this.partner.loadAccounts()).find(row => String(row.uid) === account.uid)
    if (legacy && (!existing || existing.cookie !== legacy.cookie || existing.tuneweave_account !== legacy.tuneweave_account)) {
      throw new Error("网易云绑定已变更，请重试。")
    }
    if (existing?.qq && String(existing.qq) !== String(owner)) throw new Error("此网易云账号已绑定其他主人。")
    if (existing?.tuneweave_account && existing.tuneweave_account !== account.alias) {
      throw new Error("网易云绑定已变更，请重试。")
    }
    if (!existing?.tuneweave_account || !existing.qq) {
      await this.partner.saveAccount({ uid: account.uid, nickname: profile.nickname, qq: owner, tuneweave_account: account.alias },
        { signal, expectedBinding: existing ?? null })
    }
    const music = (await readMusicAccounts(this.accountsFile)).netease
    const same = music && recordedNeteaseOwner(music, owner) && music.alias === account.alias && String(music.uid) === account.uid
    if (!music || same || selectPublic) {
      const saved = await saveMusicAccount("netease", { alias: account.alias, uid: account.uid, nickname: profile.nickname || (same ? music.nickname : ""),
        credential: same ? music.credential ?? "" : "", owner }, { file: this.accountsFile, expected: music ?? null, signal })
      if (!saved) throw new Error("网易云绑定已变更，请重试。")
    }
    return true
  }
  async reuseMusicLogin(platform: string, owner: number, signal: AbortSignal, selectPublic: boolean) {
    if (platform === "netease") return this.reuseNeteaseLogin(owner, signal, selectPublic)
    const saved = (await readMusicAccounts(this.accountsFile))[platform]
    if (!saved?.alias || !musicAccountAlias.test(saved.alias) || saved.owner !== owner || !saved.uid) return false
    const alias = saved.alias
    if ((platform === "kugou" || platform === "soda") && saved.credential?.startsWith("twc1_")) {
      // Reading either provider's profile can rotate its session. Keep the
      // stored alias and the caller credential together in one request.
      try {
        await refreshOwnMusicAccount(this, platform, owner, signal, { alias, uid: String(saved.uid) })
        return true
      } catch (error) {
        if (musicAuthenticationRequired(error)) return false
        throw error
      }
    }
    const verify = async () => {
      const { data, accountSelected } = await this.tuneweave.request<TuneWeaveQrProfile>(
        "/v1/account?" + new URLSearchParams({ platform, account: alias }), { signal, redirect: "error", accountSelection: { platform, alias } })
      signal.throwIfAborted()
      if (!accountSelected || data?.platform !== platform || data.account !== alias) throw new Error("平台登录账号未确认，请使用 #音乐重新登录 核实。")
      if (data.user_id != null && String(data.user_id) !== String(saved.uid)) throw new Error("平台登录账号不一致，请使用 #音乐重新登录 核实。")
      if (data.authenticated === false) return false
      if (data.authenticated !== true || String(data.user_id) !== String(saved.uid)) throw new Error("平台登录账号不一致，请使用 #音乐重新登录 核实。")
      const current = (await readMusicAccounts(this.accountsFile))[platform]
      if (current?.owner !== owner || current.alias !== alias || current.uid !== saved.uid) throw new Error("音乐账号绑定已变更，请重试。")
      signal.throwIfAborted()
      return true
    }
    try {
      if (await verify()) return true
    } catch (error) {
      if (!musicAuthenticationRequired(error)) throw error
    }
    if (platform !== "qq" || !saved.credential?.startsWith("twc1_")) return false
    try {
      await refreshOwnMusicAccount(this, platform, owner, signal, { alias, uid: String(saved.uid) })
      return await verify()
    } catch (error) {
      if (musicAuthenticationRequired(error)) return false
      throw error
    }
  }
  async platforms() {
    const items = await this.tuneweave.request<Capability[]>("/v1/capabilities")
    return Object.entries(MUSIC_PLATFORMS).map(([platform, name]) => ({ platform, name, capabilities: items.find(i => i.platform === platform && i.registered)?.capabilities || [] })).filter(i => i.capabilities.length)
  }
  async search(platform: string, keyword: string, page = 1,
    { limit = this.config.search_limit, offset = (page - 1) * this.config.search_limit, variant, signal }: {
      limit?: number; offset?: number; variant?: "cloud"; signal?: AbortSignal
    } = {}) {
    if (platform === "bilibili" && keyword.trim()) {
      return { tracks: await searchBilibiliAudio(this.tuneweave, keyword.trim(), limit, offset, signal), accountStatus: "unconfigured" }
    }
    if (!Object.hasOwn(MUSIC_PLATFORMS, platform) || !keyword.trim()) throw new Error("请选择有效平台并输入歌曲关键词")
    // Kuwo supports authenticated playback but its catalog is public only.
    const account = platform === "kuwo" ? undefined : (await readMusicAccounts(this.accountsFile))[platform]
    const { alias, credential } = account || {}
    const params = new URLSearchParams({
      platform, type: "track", q: keyword.trim(), limit: String(limit), offset: String(offset),
      ...(variant ? { variant } : {}),
      ...(alias && !credential ? { account: alias } : {}),
    })
    const { data: items, accountSelected } = await this.usePublicAccount(platform, { [platform]: account }, signal, accounts =>
      this.request<SearchItem[]>(`/v1/search?${params}`, accounts, { platform, alias, hasCredential: Boolean(credential) }, signal))
    // Search can succeed with a stale login, so account selection alone cannot
    // confirm that the music provider still considers the account signed in.
    const accountStatus = alias || credential ? accountSelected ? "selected" : "unverified" : "unconfigured"
    return { tracks: items.filter(i => i.type === "track").map(i => i.data), accountStatus }
  }
  async searchEpisodes(keyword: string, { limit = this.config.search_limit, offset, signal }: {
    limit?: number; offset?: number; signal?: AbortSignal
  } = {}) {
    signal?.throwIfAborted()
    const account = (await readMusicAccounts(this.accountsFile)).netease?.alias
    const search = new URLSearchParams({ platform: "netease", type: "voice", variant: "legacy", limit: String(limit), q: keyword,
      ...(offset !== undefined && { offset: String(offset) }), ...(account && { account }) })
    const items = await this.tuneweave.request<VoiceSearchItem[]>(`/v1/search?${search}`, { signal, redirect: "error" })
    if (!Array.isArray(items)) throw new Error("网易云播客搜索结果无法核实。")
    const episodes = items.map(voiceSearchSelection).filter(episode => episode !== undefined)
    if (items.length && !episodes.length) throw new Error("网易云播客搜索结果缺少可核实的节目资料。")
    return episodes
  }
  async playEpisode(episode: VoiceSearchSelection, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const account = (await readMusicAccounts(this.accountsFile)).netease?.alias
    const controls = new URLSearchParams({ quality: this.config.quality, fallback: "false", unblock: "false", ...(account && { account }) })
    const result = await this.tuneweave.request<EpisodeResult>(`/v1/episodes/${encodeURIComponent(episode.ref)}/stream?${controls}`,
      { signal, redirect: "error" })
    signal?.throwIfAborted()
    return verifiedEpisodePlayback(episode, result)
  }
  async firstEpisode(keyword: string, signal?: AbortSignal) {
    const [episode] = await this.searchEpisodes(keyword, { limit: 1, signal })
    if (episode) return this.playEpisode(episode, signal)
  }
  async episodeTranscript(episode: VoiceSearchSelection, signal?: AbortSignal) {
    const result = await this.tuneweave.request<EpisodeTranscript>(`/v1/episodes/${encodeURIComponent(episode.ref)}/lyrics`, { signal, redirect: "error" })
    signal?.throwIfAborted()
    return verifiedEpisodeTranscript(episode, result)
  }
  async publicShare(target: PublicMusicTarget, signal?: AbortSignal) {
    const ref = target.platform === "kugou" && target.kind === "mv" ? `kugou:mv:${target.id}` : `${target.platform}:${target.id}`
    const name = (value: unknown) => typeof value === "string" && value.trim()
    if (target.kind === "mv") {
      const item = await this.tuneweave.request<{ kind?: string; video?: MusicMv }>(
        `/v1/videos/${encodeURIComponent(ref)}?kind=mv`, { signal, redirect: "error" })
      const mv = item?.video
      if (item?.kind !== "mv" || mv?.ref !== ref || mv.platform !== target.platform || String(mv.id) !== target.id || !name(mv.title)) {
        throw new Error("平台返回的 MV 与原链接不一致。")
      }
      return { kind: "mv" as const, mv }
    }
    if (target.kind === "episode") {
      const item = await this.tuneweave.request<EpisodeData>(`/v1/episodes/${encodeURIComponent(ref)}`, { signal, redirect: "error" })
      const episode = voiceSearchSelection({ type: "podcast_episode", data: item })
      if (!episode || episode.ref !== ref || !name(item.name)) throw new Error("节目身份无法核实。")
      return { kind: "episode" as const, episode }
    }
    const track = await this.tuneweave.request<MusicTrack>(`/v1/tracks/${encodeURIComponent(ref)}`, { signal, redirect: "error" })
    const matchesIdentity = target.platform === "qq" && target.numeric
      ? track?.extensions?.numeric_id === target.id && typeof track.id === "string" &&
        /^[A-Za-z0-9]{14}$/u.test(track.id) && track.ref === "qq:" + track.id
      : track?.ref === ref && String(track.id) === target.id
    if (!matchesIdentity || track?.platform !== target.platform || !name(track.name)) {
      throw new Error("歌曲身份无法核实。")
    }
    if (target.platform === "kugou" && (String(track.extensions?.album_audio_id) !== target.id ||
        typeof track.extensions?.hash !== "string" || track.extensions.hash.toLowerCase() !== target.hash)) {
      throw new Error("酷狗详情的音轨编号或哈希与分享页不一致。")
    }
    return { kind: "track" as const, track }
  }
  async publicMvStream(mv: MusicMv, signal?: AbortSignal) {
    const stream = await this.tuneweave.request<MusicMvStream>(
      `/v1/videos/${encodeURIComponent(mv.ref)}/stream?kind=mv&resolution=480`, { signal, redirect: "error" })
    const cdn: MusicVideoCdn = `${mv.platform}-mv`
    const url = stream?.url && musicVideoCdnUrl(stream.url, cdn)
    if (!url || stream.video_ref !== mv.ref || stream.platform !== mv.platform || stream.available !== true ||
        (mv.platform === "kugou" ? stream.format != null && stream.format !== "mp4" : stream.format !== "mp4") ||
        stream.source_range != null) {
      throw new Error("没有可核实的完整公开 MV，请打开原链接。")
    }
    let authorized = false
    const details = stream.extensions
    const sameDuration = typeof mv.duration_ms === "number" && mv.duration_ms > 0 && mv.duration_ms === stream.duration_ms
    if (mv.platform === "qq") {
      authorized = stream.platform_code === 0 && details?.selected_protocol === "mp4" && stream.fee == null && sameDuration
    } else if (mv.platform === "kugou") {
      const resource = details?.selected_resource
      const hash = resource?.hash
      authorized = stream.platform_code === 0 && stream.fee == null && details?.kind === "mv" &&
        details.backend === "anonymous_video_tracker" && resource?.pay_type === 0 && resource.privilege === 0 &&
        typeof hash === "string" && /^[a-f0-9]{32}$/iu.test(hash) &&
        url.pathname.toLowerCase().endsWith("/" + hash.toLowerCase() + ".mp4") && sameDuration
    } else {
      authorized = stream.platform_code === 200 && details?.kind === "mv" &&
        (mv.platform === "netease" ? stream.fee === 0 : stream.fee == null &&
          details.source_track_id === String(mv.id) && details.authorization_source === "current_metadata_and_play_url")
    }
    if (!authorized) throw new Error("没有可核实的完整公开 MV，请打开原链接。")
    const urls = new Set([url.href])
    const hash = mv.platform === "kugou" ? details?.selected_resource?.hash?.toLowerCase() : undefined
    const matchesUrl = hash ? (candidate: URL) => candidate.pathname.toLowerCase().endsWith("/" + hash + ".mp4") : undefined
    if (matchesUrl && Array.isArray(stream.backup_urls)) {
      for (const candidate of stream.backup_urls.slice(0, 4)) {
        const mirror = musicVideoCdnUrl(candidate, cdn)
        if (mirror && matchesUrl(mirror)) urls.add(mirror.href)
      }
    }
    return { url, urls: [...urls], matchesUrl, size: stream.size, cdn }
  }
  async publicLyrics(track: MusicTrack, signal?: AbortSignal) {
    const data = await this.tuneweave.request<{ track_ref?: unknown; plain?: unknown; translated?: unknown }>(
      `/v1/tracks/${encodeURIComponent(track.ref)}/lyrics`, { signal, redirect: "error" })
    if (data?.track_ref !== track.ref) throw new Error("平台返回的歌词与此歌曲不一致。")
    const text = (value: unknown) => typeof value === "string" && value.length <= 32_000 ? value.trim() : ""
    return { original: text(data.plain), translated: text(data.translated) }
  }
  async resolve(track: MusicTrack, { exact = false, signal }: { exact?: boolean; signal?: AbortSignal } = {}) {
    if (track.platform === "bilibili") return resolveBilibiliAudio(this.tuneweave, track, signal)
    const accounts = await readMusicAccounts(this.accountsFile), account = accounts[track.platform]
    const params = new URLSearchParams({ quality: this.config.quality, fallback: String(!exact), unblock: "false",
      ...(!exact && { fallback_platforms: Object.keys(MUSIC_PLATFORMS).filter(p => p !== track.platform).join(",") }),
      ...(account?.alias && !account.credential ? { account: account.alias } : {}) })
    const stream = await this.usePublicAccount(track.platform, exact ? { [track.platform]: account } : accounts, signal, current =>
      this.request<MusicStream>(`/v1/tracks/${encodeURIComponent(track.ref)}/stream?${params}`, current, undefined, signal))
    if (!stream?.url || stream.trial) throw new Error("没有可用的完整音源，建议主人扫码登录音乐平台")
    if (exact && (stream.resolved_platform !== track.platform || stream.origin_track !== track.ref || stream.resolved_track !== track.ref)) {
      throw new Error("平台返回的完整音源与链接中的歌曲不一致。")
    }
    return stream
  }
  async prepare(track: MusicTrack, { signal }: { signal?: AbortSignal } = {}) {
    signal?.throwIfAborted()
    const stream = await this.resolve(track, { signal })
    return this.prepareStream(track, stream, { signal })
  }
  async prepareStream(track: MusicTrack, stream: MusicStream,
    { signal, allowMediaUrl }: { signal?: AbortSignal; allowMediaUrl?: (url: URL) => boolean } = {}) {
    signal?.throwIfAborted()
    const biliAudio = track.platform === "bilibili"
    const task = await createMediaTask(this.tasksDir)
    try {
      const file = path.join(task.dir, "source.audio"), voice = path.join(task.dir, "voice.wav")
      const url = new URL(stream.url, this.tuneweave.config.api_url)
      const stripPrivate = (headers: Record<string, string> = {}) => Object.fromEntries(Object.entries(headers).filter(([key]) => !/credential|authorization|cookie/i.test(key)))
      // Credentials on local content endpoints must never follow a CDN redirect.
      const fetchMedia = async (target: string | URL, options: DownloadRequest = {}) => {
        let current = new URL(target)
        let headers = current.origin === url.origin ? { ...options.headers } : stripPrivate(options.headers)
        for (let i = 0; i < 6; i++) {
          if (!["http:", "https:"].includes(current.protocol) || current.username || current.password ||
              (biliAudio && !isBilibiliAudioCdn(current, stream.bilibili_part_ref)) ||
              (allowMediaUrl && !allowMediaUrl(current))) throw new Error("音频地址无效")
          const response = await this.fetch(current, { ...options, headers, redirect: "manual" })
          if (![301, 302, 303, 307, 308].includes(response.status)) return response
          const location = response.headers.get("location")
          await response.body?.cancel()
          if (!location) throw new Error("音频重定向缺少地址")
          const next = new URL(location, current)
          if (next.origin !== current.origin) headers = stripPrivate(headers)
          current = next
        }
        throw new Error("音频地址重定向过多")
      }
      await downloadRanges([url.href, ...(stream.backup_urls || []).map(u => new URL(u, this.tuneweave.config.api_url).href)], file, { fetch: fetchMedia, headers: stream.headers || {}, concurrency: 4, timeoutMs: this.config.download_timeout_ms, maxBytes: this.config.max_size_mb * 1024 * 1024, signal })
      const ffmpeg = await resolveCommandPath("ffmpeg", this.toolsPath), ffprobe = await resolveCommandPath("ffprobe", this.toolsPath)
      if (!ffmpeg || !ffprobe) throw new Error("请先初始化 FFmpeg 工具环境")
      const probeOptions = { cwd: task.dir, timeoutMs: 30000, signal }
      const info: ProbeResult = JSON.parse((await runMediaProcess(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file], probeOptions)).output)
      const duration = Number(info.format?.duration)
      if (!info.streams?.some(s => s.codec_type === "audio") || !Number.isFinite(duration) || duration <= 0) throw new Error("下载结果不是有效音频")
      const expected = Math.max(Number(stream.duration_ms) || 0, Number(track.duration_ms) || 0)
      if (expected && duration * 1000 < expected - Math.max(3000, expected * 0.02)) throw new Error("音频时长不足，未按完整歌曲发送")
      if (biliAudio && (!expected || info.streams.some(s => s.codec_type === "video"))) throw new Error("B 站未返回独立完整音轨")
      const encodeOptions = { cwd: task.dir, timeoutMs: this.config.download_timeout_ms, signal }
      await runMediaProcess(ffmpeg, ["-nostdin", "-y", ...(biliAudio ? ["-xerror"] : []), "-i", file, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", voice], encodeOptions)
      if (biliAudio) {
        // Check decoded samples as well as the DASH container's declared duration.
        const decoded: ProbeResult = JSON.parse((await runMediaProcess(ffprobe, ["-v", "error", "-show_entries",
          "format=duration", "-of", "json", voice], probeOptions)).output)
        const milliseconds = Number(decoded.format?.duration) * 1000
        if (!Number.isFinite(milliseconds) || Math.abs(milliseconds - expected) > Math.max(1500, expected * 0.01) ||
            Math.abs(milliseconds - duration * 1000) > 1000) throw new Error("B 站音轨未完整解码，未发送语音")
      }
      return { taskDir: task.dir, taskId: task.id, voiceFile: voice, duration, stream, track }
    } catch (error) { await releaseMediaTask(this.tasksDir, task.dir);throw error }
  }
  recoverTasks() { return recoverMediaTasks(this.tasksDir) }
  async cleanup(result: { taskDir: string }) { await releaseMediaTask(this.tasksDir, result.taskDir) }
  async createLogin(platform: string, owner: number | undefined, loginType?: string, { signal }: { signal?: AbortSignal } = {}): Promise<MusicLogin> {
    if (!Object.hasOwn(MUSIC_PLATFORMS, platform)) throw new Error("不支持的音乐平台")
    const alias = platform === "netease" && owner !== undefined ? neteaseOwnerAlias(owner) : `lotus-music-${platform}`
    const qr = await this.tuneweave.request<QrCode>("/v1/auth/qr", {
      method: "POST", body: { platform, account: alias, credential_mode: "both", ...(loginType ? { login_type: loginType } : {}) },
      signal, redirect: "error",
    })
    if (!qr.transaction_id || !qr.url && !qr.image_data_url) throw new Error("平台没有返回可用二维码")
    return { platform, key: qr.transaction_id, alias, image: qr.image_data_url || await QRCode.toDataURL(qr.url!), owner }
  }
  async waitLogin(login: Pick<MusicLogin, "platform" | "key" | "alias"> & { owner?: number },
    { signal, timeoutMs = musicLoginTimeout(login.platform), pollMs = 3000 }: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("扫码登录已取消")
      const result = await this.tuneweave.request<QrStatus>(`/v1/auth/qr/${encodeURIComponent(login.key)}`, { signal, redirect: "error" })
      if (signal?.aborted) throw new Error("扫码登录已取消")
      if (result.state === "confirmed") {
        const profile = await resolveQrProfile(this.tuneweave, { platform: login.platform, alias: login.alias, profile: result.profile, signal })
        if (login.platform === "netease") await this.partner.saveAccount({
          uid: profile.user_id, nickname: profile.nickname, qq: login.owner, tuneweave_account: login.alias,
        }, { signal })
        await saveMusicAccount(login.platform, { alias: login.alias, uid: profile.user_id, nickname: profile.nickname || "", credential: result.caller_credential?.value || "",
          owner: login.owner }, { file: this.accountsFile, signal })
        return { ok: true }
      }
      if (["expired", "failed", "verification_required"].includes(result.state)) throw new Error("二维码已过期或需要附加验证，请重新登录")
      await sleep(pollMs, undefined, { signal })
    }
    throw new Error("扫码登录超时")
  }
}
export function musicShare(track: MusicTrack, stream: Pick<MusicStream, "url" | "headers">) {
  // NapCat passes this platform directly to its signer. type=custom is signed
  // as QQ Music even with subtype=163, so keep the selected track's identity.
  const types: Partial<Record<string, MusicCard["type"]>> = { netease: "163", qq: "qq", kugou: "kugou", kuwo: "kuwo", migu: "migu" }
  const type = types[track.platform]
  if (!type) return null
  const artists = track.artists?.map(a => a.name).join(" / ") || "未知歌手", id = encodeURIComponent(track.id)
  const netease = track.episode_id ? neteaseEpisodePage(track.episode_id) : `https://music.163.com/#/song?id=${id}`
  const links: Partial<Record<string, string>> = { netease, qq: `https://y.qq.com/n/ryqq/songDetail/${id}` }
  const url = links[track.platform] || track.extensions?.url
  if (!url) return null
  const cover = track.album?.cover_url || track.artists?.[0]?.avatar_url || ""
  if (!cover) return null
  const headerKeys = Object.keys(stream.headers || {})
  const audio = URL.parse(stream.url)
  if (headerKeys.some(k => /credential|authorization|cookie/i.test(k)) || !audio ||
      audio.protocol !== "https:" || audio.username || audio.password || audio.port ||
      !audio.hostname.includes(".") || isIP(audio.hostname) || audio.pathname.startsWith("/v1/")) return null
  return { type: "music" as const, data: { type, url, audio: audio.href, title: track.name, content: artists, singer: artists, image: cover } }
}
