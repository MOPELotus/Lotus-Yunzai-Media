import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { buildMediaMessageText } from "../media/message.ts"
import { neteaseEpisodePage } from "./episode.ts"
import { parseExternalMusicShare, readQqSongMid, type ExternalMusicShare } from "./external-share.ts"

export type PublicMusicTarget =
  | { platform: "netease"; kind: "track" | "episode" | "mv"; id: string; url: string }
  | { platform: "qq"; kind: "track"; id: string; url: string }
  | { platform: "kugou"; kind: "track"; id: string; hash: string; url: string }
type ShortMusicLink = { platform: "netease"; kind: "short"; url: string }
type KugouSharePage = { platform: "kugou"; kind: "share-page"; url: string }
type QqNumericShare = { platform: "qq"; kind: "numeric"; id: string; url: string }
type StandardMusicShare = PublicMusicTarget | ShortMusicLink | KugouSharePage | QqNumericShare
type ShareLink = StandardMusicShare | ExternalMusicShare

const neteaseHosts = new Set(["music.163.com", "y.music.163.com", "m.music.163.com"])
const qqHosts = new Set(["y.qq.com", "i.y.qq.com", "i2.y.qq.com"])
const neteaseId = /^[1-9]\d{0,19}$/u
const qqMid = /^[a-zA-Z0-9]{14}$/u
const kugouCode = /^[a-zA-Z0-9]{6,32}$/u
const kugouSharePattern = /\bvar\s+dataFromSmarty\s*=\s*(\[[^\r\n]+\])\s*[,;]\s*(?:\/\/[^\r\n]*\r?\n\s*)?playType\s*=\s*["']single["']/u
const link = /(?<=^|[\s\p{Ps}\p{Pi}"'：，、；])https?:\/\/[^\s<>"'\p{Pe}\p{Pf}。，、！？；：]+/giu

function oneParameter(query: URLSearchParams, name: string) {
  const values = query.getAll(name)
  return values.length === 1 ? values[0] : undefined
}

export function parseMusicShare(value: string): ShareLink | undefined {
  const url = value.length <= 4096 && URL.parse(value)
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return
  if (url.hostname === "163cn.tv" && /^\/[A-Za-z0-9]{1,32}\/?$/u.test(url.pathname)) {
    return { platform: "netease", kind: "short", url: `https://163cn.tv${url.pathname}` }
  }
  if (neteaseHosts.has(url.hostname)) {
    const hash = url.pathname === "/" && url.hash.startsWith("#/") ? url.hash.slice(1).split("?", 2) : undefined
    const path = (hash?.[0] ?? url.pathname).replace(/^\/m\//u, "/").replace(/\/$/u, "")
    const parts = /^\/(song|dj|program|mv)(?:\/([1-9]\d{0,19}))?$/u.exec(path)
    const source = hash ? new URLSearchParams(hash[1]) : url.searchParams
    const id = parts?.[2] ?? oneParameter(source, "id")
    if (!id || !neteaseId.test(id) || (!parts && path !== "/song/media/outer/url")) return
    if (parts?.[1] === "mv") return { platform: "netease", kind: "mv", id, url: `https://music.163.com/#/mv?id=${id}` }
    const kind = parts?.[1] === "dj" || parts?.[1] === "program" ? "episode" : "track"
    return { platform: "netease", kind, id, url: kind === "episode" ? neteaseEpisodePage(id) : `https://music.163.com/#/song?id=${id}` }
  }
  if (qqHosts.has(url.hostname)) {
    const path = url.pathname.replace(/\/$/u, "")
    const song = /^\/n\/ryqq(?:_v2)?\/songDetail\/([A-Za-z0-9]+)$/u.exec(path)?.[1]
    const mobile = path === "/v8/playsong.html" || path === "/n3/other/pages/playsong/index.html"
    const id = song ?? (mobile ? oneParameter(url.searchParams, "songmid") : undefined)
    if (id && qqMid.test(id) && !/^\d+$/u.test(id)) {
      return { platform: "qq", kind: "track", id, url: `https://y.qq.com/n/ryqq/songDetail/${id}` }
    }
    const numeric = song ?? (mobile && !url.searchParams.has("songmid") ? oneParameter(url.searchParams, "songid") : undefined)
    if (numeric && neteaseId.test(numeric)) {
      return { platform: "qq", kind: "numeric", id: numeric, url: `https://y.qq.com/n/ryqq_v2/songDetail/${numeric}` }
    }
  }
  let shareCode: string | undefined
  if (url.hostname === "www.kugou.com") shareCode = /^\/share\/([A-Za-z0-9]+)\.html$/u.exec(url.pathname)?.[1]
  if (url.hostname === "m.kugou.com" && url.pathname === "/share/song.html") shareCode = oneParameter(url.searchParams, "chain")
  if (url.hostname === "t1.kugou.com" && url.pathname === "/song.html") shareCode = oneParameter(url.searchParams, "id")
  if (shareCode && kugouCode.test(shareCode)) {
    return { platform: "kugou", kind: "share-page", url: `https://www.kugou.com/share/${shareCode}.html` }
  }
  return parseExternalMusicShare(url)
}

export function findMusicShare(message: string, context: MessageFallbackContext) {
  if (context.isDelegated || (context.message_type !== "private" && context.message_type !== "group") || /^[#/]/u.test(message)) return
  const text = buildMediaMessageText({ ...context, msg: message }).replaceAll("\\/", "/")
  for (const [value] of text.matchAll(link)) {
    const target = parseMusicShare(value.replace(/[.,!;]+$/u, ""))
    if (target) return target
  }
}

export async function resolveMusicShare(target: StandardMusicShare, signal?: AbortSignal, fetch = globalThis.fetch): Promise<PublicMusicTarget> {
  if (target.kind !== "short" && target.kind !== "share-page" && target.kind !== "numeric") return target
  const timeout = AbortSignal.timeout(8000)
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout
  if (target.kind === "numeric") {
    const id = await readQqSongMid(target.id, active, fetch)
    return { platform: "qq", kind: "track", id, url: `https://y.qq.com/n/ryqq/songDetail/${id}` }
  }
  if (target.kind === "share-page") {
    const response = await fetch(new URL(target.url), { credentials: "omit", redirect: "error", signal: active })
    const limit = 512 * 1024
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel().catch(() => {})
      throw new Error("酷狗公开分享页暂时不可用。")
    }
    let size = 0, html = ""
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      active.throwIfAborted()
      size += chunk.byteLength
      if (size > limit) throw new Error("酷狗分享页超过读取限制。")
      html += decoder.decode(chunk, { stream: true })
    }
    const match = kugouSharePattern.exec(html + decoder.decode())
    let items: unknown
    try { if (match?.[1]) items = JSON.parse(match[1]) }
    catch { throw new Error("酷狗公开分享页返回了无法识别的单曲资料。") }
    const item = Array.isArray(items) && items.length === 1 ? items[0] : undefined
    const mixId: unknown = item?.mixsongid
    const hash: unknown = item?.hash
    if ((typeof mixId === "string" || typeof mixId === "number" && Number.isSafeInteger(mixId)) &&
        neteaseId.test(String(mixId)) && typeof hash === "string" && /^[a-f0-9]{32}$/iu.test(hash)) {
      return { platform: "kugou", kind: "track", id: String(mixId), hash: hash.toLowerCase(), url: target.url }
    }
    throw new Error("未能核实酷狗分享页中的单曲资料。")
  }
  let url = new URL(target.url)
  for (let hop = 0; hop < 3; hop++) {
    const response = await fetch(url, { method: "HEAD", credentials: "omit", redirect: "manual", signal: active })
    const location = response.headers.get("Location")
    if (response.status < 300 || response.status >= 400 || !location) break
    const next = URL.parse(location, url)
    const parsed = next?.protocol === "https:" ? parseMusicShare(next.href) : undefined
    if (!parsed || parsed.platform !== "netease") break
    if (parsed.kind !== "short") return parsed
    url = new URL(parsed.url)
  }
  throw new Error("网易云短链未跳转到可识别的歌曲或节目。")
}
