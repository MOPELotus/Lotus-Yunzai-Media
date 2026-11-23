import type { TuneWeaveQrProfile } from "../tuneweave/auth.ts"
import { readMusicAccounts, saveMusicAccount, type MusicAccount } from "./accounts.ts"
import type { MusicService, MusicStream, MusicTrack } from "./service.ts"

export type MusicCollection = "radio" | "daily" | "favorites"
type PrivatePlatform = "qq" | "netease"
interface Binding { platform: PrivatePlatform; alias: string; uid: string; owner: number; saved: MusicAccount }
interface RefreshResult extends TuneWeaveQrProfile { caller_credential?: { value?: string; platform?: string } }
interface Feed { shelves?: readonly { style?: number; niches?: readonly { cards?: readonly { kind?: string; id?: string; ref?: string }[] }[] }[] }
const refreshing = new Set<string>()

function loginRequired() { return Object.assign(new Error("请由绑定账号的主人在当前好友私聊使用 #音乐登录 重新扫码。"), { code: "authentication_required" }) }
function errorCode(error: unknown) { return error && typeof error === "object" && "code" in error ? error.code : undefined }
export function musicAuthenticationRequired(error: unknown) { return errorCode(error) === "authentication_required" }

export async function recommendQqSong(api: MusicService, signal: AbortSignal) {
  const feed = await api.tuneweave.request<Feed>("/v1/recommendations/feed?platform=qq&direction=forward&page=1&loaded_count=0", { signal, redirect: "error" })
  const card = feed?.shelves?.filter(shelf => shelf.style === 1).flatMap(shelf => shelf.niches ?? [])
    .flatMap(niche => niche.cards ?? []).find(card => card.kind === "track" && /^[1-9]\d{0,21}$/u.test(card.id ?? "") && card.ref === `qq:${card.id}`)
  if (!card?.id || !card.ref) return
  const track = await api.tuneweave.request<MusicTrack>(`/v1/tracks/${encodeURIComponent(card.ref)}`, { signal, redirect: "error" })
  if (!isQqTrack(track) || (String(track.id) !== card.id && track.extensions?.numeric_id !== card.id)) {
    throw new Error("QQ 音乐未返回这条推荐对应的歌曲。")
  }
  return track
}

function isQqTrack(track: MusicTrack | undefined): track is MusicTrack {
  return Boolean(track?.platform === "qq" && /^(?:qq:)[A-Za-z0-9]{1,32}$/u.test(track.ref) && track.ref === `qq:${track.id}` && track.name?.trim())
}

function checkStream(track: MusicTrack, stream: MusicStream) {
  if (!stream?.url || stream.trial || stream.resolved_platform !== track.platform ||
      stream.origin_track !== track.ref || stream.resolved_track !== track.ref) throw new Error("没有可核实的原平台完整音源。")
  return stream
}

function streamRoute(track: MusicTrack, api: MusicService) {
  return `/v1/tracks/${encodeURIComponent(track.ref)}/stream?${new URLSearchParams({ quality: api.config.quality, fallback: "false", unblock: "false" })}`
}

export async function openPublicQqStream(api: MusicService, track: MusicTrack, signal: AbortSignal) {
  return checkStream(track, await api.tuneweave.request<MusicStream>(streamRoute(track, api), { signal, redirect: "error" }))
}

async function binding(api: MusicService, platform: PrivatePlatform, owner: number, signal: AbortSignal): Promise<Binding> {
  signal.throwIfAborted()
  const accounts = await readMusicAccounts(api.accountsFile).catch(() => { throw new Error("音乐账号记录无法读取。") })
  const saved = accounts[platform]
  const uid = String(saved?.uid ?? "")
  if (!saved?.alias || !/^[A-Za-z0-9_-]{1,128}$/u.test(saved.alias) || !/^[A-Za-z0-9_-]{1,128}$/u.test(uid) ||
      (saved.owner !== owner && !(platform === "netease" && saved.owner === undefined && saved.alias === `lotus-nep-${owner}`))) throw loginRequired()
  signal.throwIfAborted()
  return { platform, alias: saved.alias, uid, owner, saved }
}

async function assertCurrent(api: MusicService, expected: Binding, signal: AbortSignal) {
  const actual = await binding(api, expected.platform, expected.owner, signal)
  if (actual.alias !== expected.alias || actual.uid !== expected.uid || actual.saved.credential !== expected.saved.credential) {
    throw new Error("音乐账号已变更，请重新查询。")
  }
}

async function accountRequest<T>(api: MusicService, expected: Binding, route: string, signal: AbortSignal) {
  const target = `${route}${route.includes("?") ? "&" : "?"}account=${encodeURIComponent(expected.alias)}`
  const response = await api.tuneweave.request<T>(target, { signal, redirect: "error",
    accountSelection: { platform: expected.platform, alias: expected.alias } })
  signal.throwIfAborted()
  if (!response.accountSelected) throw new Error("TuneWeave 未确认选用的音乐账号。")
  return response.data
}

async function verify(api: MusicService, expected: Binding, signal: AbortSignal) {
  const profile = await accountRequest<TuneWeaveQrProfile>(api, expected, `/v1/account?platform=${expected.platform}`, signal)
  if (profile?.platform !== expected.platform || profile.account !== expected.alias ||
      profile.user_id != null && String(profile.user_id) !== expected.uid) throw new Error("音乐账号身份无法核实。")
  if (profile.authenticated === false) throw loginRequired()
  if (profile.authenticated !== true || String(profile.user_id) !== expected.uid) throw new Error("音乐账号身份无法核实。")
  await assertCurrent(api, expected, signal)
  return profile
}

async function refreshMusicBinding(api: MusicService, expected: Binding, signal: AbortSignal) {
  const key = JSON.stringify([api.tuneweave.config.api_url, api.accountsFile, expected.platform])
  if (refreshing.has(key)) throw new Error("此平台的音乐登录正在续期。")
  refreshing.add(key)
  try { return await renew(api, expected, signal) }
  finally { refreshing.delete(key) }
}

export async function refreshOwnMusicAccount(api: MusicService, platform: PrivatePlatform, owner: number, signal: AbortSignal,
  selection?: { alias: string; uid: string }) {
  const current = await binding(api, platform, owner, signal)
  if (selection && (current.alias !== selection.alias || current.uid !== selection.uid)) throw new Error("音乐账号已变更，请重新查询。")
  return refreshMusicBinding(api, current, signal)
}

async function renew(api: MusicService, expected: Binding, signal: AbortSignal) {
  const { platform } = expected
  const credential = expected.saved.credential
  if (!credential?.startsWith("twc1_")) throw loginRequired()
  await assertCurrent(api, expected, signal)
  const { data, accountSelected } = await api.tuneweave.request<RefreshResult>("/v1/auth/session/refresh", { method: "POST", signal,
    redirect: "error", body: { platform, account: expected.alias, credential_mode: "both" }, credentials: [credential],
    accountSelection: { platform, alias: expected.alias } })
  if (!accountSelected || data?.platform !== platform || data.account !== expected.alias ||
      data.user_id != null && String(data.user_id) !== expected.uid) throw new Error("音乐账号身份无法核实。")
  if (data.authenticated === false) throw loginRequired()
  if (data.authenticated !== true || String(data.user_id) !== expected.uid || data.caller_credential?.platform !== platform ||
      !data.caller_credential.value?.startsWith("twc1_")) throw new Error("音乐账号身份无法核实。")
  await assertCurrent(api, expected, signal)
  const saved = await saveMusicAccount(platform, { credential: data.caller_credential.value }, { file: api.accountsFile, expected: expected.saved, signal })
    .catch(() => { throw new Error("无法保存音乐登录续期结果。") })
  if (!saved) {
    throw new Error("音乐账号已变更，未保存旧会话的续期结果。")
  }
  return data
}

export async function ownMusicStatus(api: MusicService, platform: PrivatePlatform, owner: number, signal: AbortSignal) {
  return verify(api, await binding(api, platform, owner, signal), signal)
}

export async function readQqCollection(api: MusicService, kind: MusicCollection, owner: number, page: number, signal: AbortSignal) {
  let expected = await binding(api, "qq", owner, signal)
  const limit = kind === "radio" ? 5 : kind === "daily" || page === 0 ? 30 : 10
  const offset = kind === "favorites" ? Math.max(0, page - 1) * limit : 0
  const route = kind === "radio" ? "/v1/recommendations/tracks?platform=qq&source=personalized&limit=5" :
    kind === "daily" ? `/v1/playlists/${encodeURIComponent("qq:dir:202")}/tracks?limit=${limit}&offset=0` :
      `/v1/account/favorites/tracks?platform=qq&limit=${limit}&offset=${offset}`
  async function load() {
    await verify(api, expected, signal)
    const items = await accountRequest<MusicTrack[]>(api, expected, route, signal)
    await verify(api, expected, signal)
    if (!Array.isArray(items) || items.some(item => !isQqTrack(item))) throw new Error("QQ 音乐未返回可核实的歌曲。")
    return items.slice(0, limit)
  }
  try { return { tracks: await load(), binding: expected } }
  catch (error) {
    if (errorCode(error) !== "authentication_required") throw error
    await refreshMusicBinding(api, expected, signal)
    const renewed = await binding(api, "qq", owner, signal)
    if (renewed.alias !== expected.alias || renewed.uid !== expected.uid) throw new Error("音乐账号已变更，请重新查询。")
    expected = renewed
    return { tracks: await load(), binding: expected }
  }
}

export async function openOwnQqStream(api: MusicService, expected: Binding, track: MusicTrack, signal: AbortSignal) {
  await verify(api, expected, signal)
  const stream = checkStream(track, await accountRequest<MusicStream>(api, expected, streamRoute(track, api), signal))
  await verify(api, expected, signal)
  return stream
}

export async function verifyQqSelection(api: MusicService, expected: Binding, signal: AbortSignal) {
  await verify(api, expected, signal)
}
