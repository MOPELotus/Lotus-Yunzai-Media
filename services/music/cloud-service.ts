import { isChatFileName, maxChatFileBytes, type ChatFile } from "../../../../lib/chat-files.ts"
import type { TuneWeaveRequestOptions } from "../tuneweave/service.ts"
import { findOwnedNeteaseAccount, verifyNeteaseAccount, verifyOrRenewNeteaseAccount } from "./netease-account.ts"
import type { MusicService, MusicStream, MusicTrack } from "./service.ts"

const trackReference = /^netease:[1-9]\d{0,21}$/u
const pageSize = 100
const refreshInterval = 5 * 60_000

interface Binding { readonly owner: number; readonly alias: string; readonly uid: string; readonly key: string }
interface CloudTrack { readonly ref: string; readonly track: MusicTrack; readonly filename?: string; readonly matched_track_ref?: string }
interface Snapshot { readonly tracks: readonly CloudTrack[]; readonly used?: number; readonly capacity?: number; readonly loadedAt: number }
interface Cache { snapshot?: Snapshot; reading?: Promise<Snapshot> }
interface CloudDownload { ref?: unknown; platform?: unknown; available?: unknown; url?: unknown; duration_ms?: number }
interface CloudUpload { track_ref?: unknown; published?: unknown }
interface CloudMatch { cloud_track_ref?: unknown; target_track_ref?: unknown; matched?: unknown;
  extensions?: { cloud_user_id?: unknown; response?: { code?: unknown } } }

function isTrackReference(value: unknown): value is string {
  return typeof value === "string" && trackReference.test(value)
}

function unsignedCount(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

export function isCloudMediaUrl(url: URL) {
  return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    ["music.126.net", "music.163.com", "nos.netease.com"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
}

function checkedTrack(item: CloudTrack) {
  if (!isTrackReference(item?.ref) || item.ref !== item.track?.ref || item.track.platform !== "netease" ||
      typeof item.track.name !== "string" || !item.track.name.trim()) throw new Error("云盘曲目数据无法核实。")
  return item
}

function audioContentType(file: ChatFile) {
  const leading = Buffer.from(file.bytes.subarray(0, 12))
  const format = file.name.split(".").at(-1)?.toLowerCase()
  if (format === "flac" && leading.toString("ascii", 0, 4) === "fLaC") return "audio/flac"
  if (format === "mp3" && (leading.toString("ascii", 0, 3) === "ID3" ||
      (leading[0] === 0xff && (leading[1]! & 0xe6) === 0xe2))) return "audio/mpeg"
  if (format === "wav" && leading.toString("ascii", 0, 4) === "RIFF" && leading.toString("ascii", 8, 12) === "WAVE") return "audio/wav"
  if (format === "ogg" && leading.toString("ascii", 0, 4) === "OggS") return "audio/ogg"
  if (format === "m4a" && leading.toString("ascii", 4, 8) === "ftyp") return "audio/mp4"
}

export class NeteaseCloudLibrary {
  private readonly accounts = new Map<string, Cache>()
  constructor(readonly now = Date.now) {}

  private async binding(api: MusicService, owner: number, signal: AbortSignal): Promise<Binding> {
    const account = await findOwnedNeteaseAccount(api, owner, signal)
    if (!account) throw new Error("请先在当前好友私聊使用 #音乐登录 绑定自己的网易云账号。")
    return { ...account, key: JSON.stringify([api.tuneweave.config.api_url, owner, account.alias, account.uid]) }
  }

  private async request<T>(api: MusicService, binding: Binding, path: string, params: Record<string, string>,
    signal: AbortSignal, options: Pick<TuneWeaveRequestOptions, "method" | "audio" | "body"> = {}) {
    await this.assertCurrent(api, binding, signal)
    const query = new URLSearchParams({ account: binding.alias, ...params })
    const result = await api.tuneweave.request<T>(`/v1/${path}?${query}`, { ...options, signal, redirect: "error",
      accountSelection: { platform: "netease", alias: binding.alias } })
    signal.throwIfAborted()
    if (!result.accountSelected) throw new Error("TuneWeave 未确认选用的网易云账号。")
    return result
  }

  async verify(api: MusicService, owner: number, signal: AbortSignal) {
    const binding = await this.binding(api, owner, signal)
    await verifyOrRenewNeteaseAccount(api, binding, signal).catch(error => {
      if (error?.code === "authentication_required") throw new Error("网易云登录已过期，请在当前好友私聊重新扫码。")
      throw error
    })
    await this.assertCurrent(api, binding, signal)
    return binding
  }

  async assertCurrent(api: MusicService, expected: Binding, signal: AbortSignal) {
    if ((await this.binding(api, expected.owner, signal)).key !== expected.key) throw new Error("网易云绑定已变更，请重新查询云盘。")
  }

  async list(api: MusicService, binding: Binding, signal: AbortSignal, refresh = false) {
    let cache = this.accounts.get(binding.key)
    if (!cache) { cache = {}; this.accounts.set(binding.key, cache) }
    if (!refresh && cache.snapshot && this.now() - cache.snapshot.loadedAt < refreshInterval) return cache.snapshot
    const old = cache.reading
    if (old) {
      const result = await old
      await this.assertCurrent(api, binding, signal)
      return result
    }
    const request = this.readAll(api, binding, signal)
    cache.reading = request
    try {
      const snapshot = await request
      if (this.accounts.get(binding.key) === cache) cache.snapshot = snapshot
      return snapshot
    } finally {
      if (cache.reading === request) delete cache.reading
    }
  }

  clear(binding: Binding) { this.accounts.delete(binding.key) }

  private async readAll(api: MusicService, binding: Binding, signal: AbortSignal): Promise<Snapshot> {
    const tracks = new Map<string, CloudTrack>()
    let offset = 0
    let total: number | undefined
    let used: number | undefined
    let capacity: number | undefined
    const active = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    for (let page = 0; page < 2500; page++) {
      const { data, pagination } = await this.request<CloudTrack[]>(api, binding, "account/cloud/tracks",
        { platform: "netease", limit: String(pageSize), offset: String(offset) }, active)
      const meta = pagination as { offset?: unknown; total?: unknown; next_offset?: unknown; has_more?: unknown;
        extensions?: { storage_size?: unknown; storage_max_size?: unknown } } | undefined
      const reportedTotal = unsignedCount(meta?.total)
      if (!Array.isArray(data) || data.length > pageSize || meta?.offset !== offset || typeof meta.has_more !== "boolean" ||
          page > 0 && reportedTotal !== total) throw new Error("云盘分页结果无法核实，请重新刷新。")
      total = reportedTotal
      used ??= unsignedCount(meta.extensions?.storage_size)
      capacity ??= unsignedCount(meta.extensions?.storage_max_size)
      for (const raw of data) {
        const item = checkedTrack(raw)
        if (tracks.has(item.ref)) throw new Error("云盘曲目在刷新期间发生变化，请重新刷新。")
        tracks.set(item.ref, item)
      }
      if (!meta.has_more) {
        if (total !== undefined && tracks.size !== total) throw new Error("云盘曲目数在刷新期间发生变化，请重新刷新。")
        await verifyNeteaseAccount(api, binding, active)
        await this.assertCurrent(api, binding, active)
        return { tracks: [...tracks.values()], used, capacity, loadedAt: this.now() }
      }
      if (!data.length || meta.next_offset !== offset + data.length) throw new Error("云盘分页没有前进，请重新刷新。")
      offset = meta.next_offset
    }
    throw new Error("网易云盘曲目数超出本次刷新上限。")
  }

  async stream(api: MusicService, binding: Binding, track: CloudTrack, signal: AbortSignal): Promise<MusicStream> {
    const { data } = await this.request<CloudDownload>(api, binding, `account/cloud/tracks/${encodeURIComponent(checkedTrack(track).ref)}/download`, {}, signal)
    const url = typeof data?.url === "string" && URL.parse(data.url)
    if (data?.ref !== track.ref || data.platform !== "netease" || data.available !== true || !url || !isCloudMediaUrl(url)) {
      throw new Error("当前云盘曲目没有可用的完整音源。")
    }
    await verifyNeteaseAccount(api, binding, signal)
    await this.assertCurrent(api, binding, signal)
    return { url: url.href, duration_ms: unsignedCount(data.duration_ms), resolved_platform: "netease" }
  }

  private async trackDetails(api: MusicService, binding: Binding, ref: string, signal: AbortSignal) {
    const { data } = await this.request<CloudTrack[]>(api, binding, "account/cloud/tracks/details", { platform: "netease", refs: ref }, signal)
    if (!Array.isArray(data) || data.length !== 1 || data[0]?.ref !== ref) throw new Error("当前云盘曲目无法核实，请重新查询。")
    return checkedTrack(data[0])
  }

  async match(api: MusicService, binding: Binding, source: CloudTrack, targetId: string, signal: AbortSignal) {
    const cloudRef = checkedTrack(source).ref
    const publicRef = "netease:" + targetId
    if (!isTrackReference(publicRef)) throw new Error("请输入有效的网易云官方歌曲编号。")
    const target = await api.publicShare({ platform: "netease", kind: "track", id: targetId,
      url: "https://music.163.com/#/song?id=" + targetId }, signal)
    if (target.kind !== "track") throw new Error("网易云官方曲目无法核实。")
    const current = await this.trackDetails(api, binding, cloudRef, signal)
    await verifyNeteaseAccount(api, binding, signal)
    await this.assertCurrent(api, binding, signal)
    if (cloudRef === publicRef || current.matched_track_ref === publicRef) return { changed: false, name: target.track.name }
    try {
      const { data } = await this.request<CloudMatch>(api, binding, "account/cloud/matches", { platform: "netease" }, signal, {
        method: "POST", body: { user_id: binding.uid, cloud_track_id: cloudRef.slice("netease:".length), target_track_id: targetId },
      })
      if (data?.matched !== true || data.cloud_track_ref !== cloudRef || data.target_track_ref !== publicRef ||
          String(data.extensions?.cloud_user_id) !== binding.uid || String(data.extensions?.response?.code) !== "200") throw new Error("unconfirmed")
      const updated = await this.trackDetails(api, binding, cloudRef, signal)
      await verifyNeteaseAccount(api, binding, signal)
      await this.assertCurrent(api, binding, signal)
      if (updated.matched_track_ref !== publicRef) throw new Error("unconfirmed")
      return { changed: true, name: target.track.name }
    } catch {
      throw new Error("这次云盘匹配结果未确认。请先用 #云盘更新 核对，避免重复提交。")
    } finally { this.clear(binding) }
  }

  async upload(api: MusicService, binding: Binding, file: ChatFile, signal: AbortSignal) {
    if (!isChatFileName(file.name) || file.bytes.byteLength < 12 || file.bytes.byteLength > maxChatFileBytes) {
      throw new Error("请选择不超过 16 MiB 的音频附件。")
    }
    const contentType = audioContentType(file)
    if (!contentType) throw new Error("请选择内容与扩展名一致的 FLAC、MP3、WAV、OGG 或 M4A 音频。")
    // Reconfirm the server-side account after loading the attachment and before the one write.
    if ((await this.verify(api, binding.owner, signal)).key !== binding.key) throw new Error("网易云绑定已变更，请重新上传。")
    const stem = file.name.replace(/\.[^.]+$/u, "")
    const parts = /^(.+?)\s*-\s*(.+)$/u.exec(stem)
    const params = { platform: "netease", filename: file.name }
    if (parts) Object.assign(params, { artist: parts[1]!.trim(), song_name: parts[2]!.trim() })
    try {
      const { data } = await this.request<CloudUpload>(api, binding, "account/cloud/uploads", params, signal,
        { method: "POST", audio: { bytes: file.bytes, contentType } })
      if (data?.published !== true || !isTrackReference(data.track_ref)) throw new Error("unconfirmed")
      await this.assertCurrent(api, binding, signal)
    } catch { throw new Error("这次云盘上传结果未确认。请先用 #云盘更新 核对，避免重复提交。") }
    finally { this.clear(binding) }
  }
}

export function matchCloudTracks(tracks: readonly CloudTrack[], keyword: string) {
  const query = keyword.trim().normalize("NFKC").toLowerCase()
  if (!query) return tracks
  return tracks.filter(({ track, filename }) => [track.name, filename, ...track.artists?.map(artist => artist.name) ?? []]
    .some(value => typeof value === "string" && value.normalize("NFKC").toLowerCase().includes(query)))
}
