import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { readPublicResponse } from "../public-read.ts"
import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { buildMediaMessageText } from "../media/message.ts"
import { neteaseEpisodePage } from "./episode.ts"
import { parseExternalMusicShare, type ExternalMusicShare } from "./external-share.ts"

export type PublicMusicTarget =
  | { platform: "netease"; kind: "track" | "episode" | "mv"; id: string; url: string }
  | { platform: "qq"; kind: "track"; id: string; url: string; numeric?: true }
  | { platform: "qq"; kind: "mv"; id: string; url: string }
  | { platform: "soda"; kind: "track"; id: string; url: string }
  | { platform: "kuwo"; kind: "track" | "mv"; id: string; url: string }
  | { platform: "kugou"; kind: "track"; id: string; hash: string; url: string }
  | { platform: "kugou"; kind: "mv"; id: string; url: string }
type ShortMusicLink = { platform: "netease" | "soda"; kind: "short"; url: string }
type KugouSharePage = { platform: "kugou"; kind: "share-page"; url: string; mvCode?: string }
type StandardMusicShare = PublicMusicTarget | ShortMusicLink | KugouSharePage
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
    const vid = /^\/n\/ryqq(?:_v2)?\/mv\/([A-Za-z0-9]{6,32})$/u.exec(path)?.[1]
    if (url.hostname === "y.qq.com" && vid) return { platform: "qq", kind: "mv", id: vid, url: `https://y.qq.com/n/ryqq/mv/${vid}` }
    const song = /^\/n\/ryqq(?:_v2)?\/songDetail\/([A-Za-z0-9]+)$/u.exec(path)?.[1]
    const mobile = path === "/v8/playsong.html" || path === "/n3/other/pages/playsong/index.html"
    const id = song ?? (mobile ? oneParameter(url.searchParams, "songmid") : undefined)
    if (id && qqMid.test(id) && !/^\d+$/u.test(id)) {
      return { platform: "qq", kind: "track", id, url: `https://y.qq.com/n/ryqq/songDetail/${id}` }
    }
    const numeric = song ?? (mobile && !url.searchParams.has("songmid") ? oneParameter(url.searchParams, "songid") : undefined)
    if (numeric && neteaseId.test(numeric)) {
      return { platform: "qq", kind: "track", numeric: true, id: numeric, url: `https://y.qq.com/n/ryqq_v2/songDetail/${numeric}` }
    }
  }
  const route = url.pathname.replace(/\/$/u, "")
  if (url.hostname === "qishui.douyin.com" && /^\/s\/[A-Za-z0-9]{4,24}$/u.test(route)) {
    return { platform: "soda", kind: "short", url: "https://qishui.douyin.com" + route + "/" }
  }
  if (url.hostname === "music.douyin.com" && route === "/qishui/share/track") {
    const id = oneParameter(url.searchParams, "track_id")
    if (id && neteaseId.test(id)) {
      return { platform: "soda", kind: "track", id, url: "https://music.douyin.com/qishui/share/track?track_id=" + id }
    }
  }
  if (url.hostname === "h5app.kuwo.cn") {
    const video = route === "/m/bodian/play.html"
    if (!video && route !== "/m/bodian/playMusic.html") return
    const parameter = video ? "mvId" : "musicId"
    const id = oneParameter(url.searchParams, parameter)
    if (id && neteaseId.test(id)) {
      return { platform: "kuwo", kind: video ? "mv" : "track", id, url: `https://h5app.kuwo.cn${route}?${parameter}=${id}` }
    }
  }
  if (url.hostname === "www.kuwo.cn") {
    const id = /^\/mvplay\/([1-9]\d{0,19})$/u.exec(route)?.[1]
    if (id) return { platform: "kuwo", kind: "mv", id, url: `https://www.kuwo.cn/mvplay/${id}` }
  }
  let shareCode: string | undefined
  if (url.hostname === "www.kugou.com") {
    const mvCode = /^\/mvweb\/html\/mv_([a-z0-9]{3,32})$/u.exec(route)?.[1]
    if (mvCode) return { platform: "kugou", kind: "share-page", mvCode, url: `https://www.kugou.com/mvweb/html/mv_${mvCode}/` }
  }
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
  if (target.kind !== "short" && target.kind !== "share-page") return target
  const timeout = AbortSignal.timeout(8000)
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout
  if (target.kind === "share-page") {
    const response = await readPublicResponse((target, init) => fetch(new URL(target), init), new URL(target.url), { credentials: "omit", redirect: "error", signal: active })
    const limit = 512 * 1024
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel().catch(() => {})
      throw new Error($t("services.music.share-link.text_2eaa9fcc04"))
    }
    let size = 0, html = ""
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      active.throwIfAborted()
      size += chunk.byteLength
      if (size > limit) throw new Error($t("services.music.share-link.text_dc09221aba"))
      html += decoder.decode(chunk, { stream: true })
    }
    html += decoder.decode()
    if (target.mvCode) {
      const id = /\bvar\s+mv_id\s*=\s*"([1-9]\d{0,19})"\s*;/u.exec(html)?.[1]
      const code = /\bvar\s+encode_mvid\s*=\s*"([a-z0-9]+)"\s*;/u.exec(html)?.[1]
      if (id && code === target.mvCode) return { platform: "kugou", kind: "mv", id, url: target.url }
      throw new Error($t("services.music.share-link.text_671a355629"))
    }
    const match = kugouSharePattern.exec(html)
    let items: unknown
    try { if (match?.[1]) items = JSON.parse(match[1]) }
    catch { throw new Error($t("services.music.share-link.text_82cd2c975e")) }
    const item = Array.isArray(items) && items.length === 1 ? items[0] : undefined
    const mixId: unknown = item?.mixsongid
    const hash: unknown = item?.hash
    if ((typeof mixId === "string" || typeof mixId === "number" && Number.isSafeInteger(mixId)) &&
        neteaseId.test(String(mixId)) && typeof hash === "string" && /^[a-f0-9]{32}$/iu.test(hash)) {
      return { platform: "kugou", kind: "track", id: String(mixId), hash: hash.toLowerCase(), url: target.url }
    }
    throw new Error($t("services.music.share-link.text_2d77b3150e"))
  }
  let url = new URL(target.url)
  for (let hop = 0; hop < 3; hop++) {
    const request = target.platform === "soda" ? { headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 13)" } } : { method: "HEAD" }
    const response = await readPublicResponse((target, init) => fetch(new URL(target), init), url, { ...request, credentials: "omit", redirect: "manual", signal: active })
    await response.body?.cancel().catch(() => {})
    const location = response.headers.get("Location")
    if (response.status < 300 || response.status >= 400 || !location) break
    const next = URL.parse(location, url)
    const parsed = next?.protocol === "https:" ? parseMusicShare(next.href) : undefined
    if (!parsed || parsed.platform !== target.platform) break
    if (parsed.kind !== "short") return parsed
    url = new URL(parsed.url)
  }
  throw new Error(target.platform === "soda" ? $t("services.music.share-link.text_e11ef272fc") : $t("services.music.share-link.text_2d15c6ba90"))
}
