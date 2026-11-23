import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { buildMediaMessageText } from "../media/message.ts"
import { neteaseEpisodePage } from "./episode.ts"

export type PublicMusicTarget =
  | { platform: "netease"; kind: "track" | "episode"; id: string; url: string }
  | { platform: "qq"; kind: "track"; id: string; url: string }
type ShortMusicLink = { platform: "netease"; kind: "short"; url: string }
type ShareLink = PublicMusicTarget | ShortMusicLink

const neteaseHosts = new Set(["music.163.com", "y.music.163.com", "m.music.163.com"])
const qqHosts = new Set(["y.qq.com", "i.y.qq.com", "i2.y.qq.com"])
const neteaseId = /^[1-9]\d{0,19}$/u
const qqMid = /^[a-zA-Z0-9]{14}$/u
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
    const parts = /^\/(song|dj|program)(?:\/([1-9]\d{0,19}))?$/u.exec(path)
    const source = hash ? new URLSearchParams(hash[1]) : url.searchParams
    const id = parts?.[2] ?? oneParameter(source, "id")
    if (!id || !neteaseId.test(id) || (!parts && path !== "/song/media/outer/url")) return
    const kind = parts?.[1] === "dj" || parts?.[1] === "program" ? "episode" : "track"
    return { platform: "netease", kind, id, url: kind === "episode" ? neteaseEpisodePage(id) : `https://music.163.com/#/song?id=${id}` }
  }
  if (qqHosts.has(url.hostname)) {
    const path = url.pathname.replace(/\/$/u, "")
    const song = /^\/n\/ryqq\/songDetail\/([a-zA-Z0-9]{14})$/u.exec(path)?.[1]
    const mobile = (path === "/v8/playsong.html" || path === "/n3/other/pages/playsong/index.html") && oneParameter(url.searchParams, "songmid")
    const id = song || mobile
    if (id && qqMid.test(id)) return { platform: "qq", kind: "track", id, url: `https://y.qq.com/n/ryqq/songDetail/${id}` }
  }
}

export function findMusicShare(message: string, context: MessageFallbackContext) {
  if (context.isDelegated || (context.message_type !== "private" && context.message_type !== "group") || /^[#/]/u.test(message)) return
  const text = buildMediaMessageText({ ...context, msg: message }).replaceAll("\\/", "/")
  for (const [value] of text.matchAll(link)) {
    const target = parseMusicShare(value.replace(/[.,!;]+$/u, ""))
    if (target) return target
  }
}

export async function resolveMusicShare(target: ShareLink, signal?: AbortSignal, fetch = globalThis.fetch): Promise<PublicMusicTarget> {
  if (target.kind !== "short") return target
  const timeout = AbortSignal.timeout(8000)
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout
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
