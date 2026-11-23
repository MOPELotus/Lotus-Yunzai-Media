import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { readOptionalConfigFile } from "../../../../lib/config.ts"
import { lockFile } from "../../../../lib/file-lock.ts"
import type { MessageReply } from "../../../../lib/messages.ts"
import { dataPath } from "../../core/path.ts"
import { renderTemplate } from "../../core/render/service.ts"
import { buildMediaMessageText } from "../media/message.ts"
import { createSubscriptionConfig } from "../subscriptions/config.ts"
import { biliPgcDefaultDuration, createBiliPgcPlayback, playbackQuality } from "./pgc-playback.ts"

const site = "https://www.bilibili.com"
const api = "https://api.bilibili.com/pgc/view/web/season"
const maxResponse = 2 * 1024 * 1024
const feature = "B 站番剧预览"
const link = /(?<=^|[\s\p{Ps}\p{Pi}"'：，、；])(?:https?:\/\/|(?=www\.bilibili\.com\/))[^\s<>"'\p{Pe}\p{Pf}。，、！？；：]+/giu
const hosts = new Set(["www.bilibili.com", "bilibili.com", "m.bilibili.com"])
const playCommand = /^#(?:播放|b站(?:下载|下视频))\s+(\S+)\s*$/iu
const idPattern = /^[1-9]\d{0,15}$/u
const config = createSubscriptionConfig(dataPath, lockFile)
const deployment = new URL("../../../../", import.meta.url)

type Fields = Record<string, unknown>
export type BiliPgcFetch = (url: URL, options: RequestInit) => Promise<Response>
export interface BiliPgcTarget { readonly kind: "ep" | "ss"; readonly id: string; readonly url: string }
export interface BiliPgcEpisode {
  readonly id: string
  readonly cid?: string
  readonly title: string
  readonly cover?: string
  readonly duration?: number
  readonly badge: string
  readonly status?: unknown
  readonly rights: Fields
}
export interface BiliPgc {
  readonly id: string
  readonly title: string
  readonly cover?: string
  readonly desc: string
  readonly update: string
  readonly rating: string
  readonly stats: Fields
  readonly rights: Fields
  readonly episode?: BiliPgcEpisode
}

function fields(value: unknown): Fields {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {}
}

function text(value: unknown, limit: number) {
  return typeof value === "string" ? Array.from(value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ").trim()).slice(0, limit).join("") : ""
}

function id(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === "string" && idPattern.test(value)) return value
}

function image(value: unknown) {
  const url = typeof value === "string" && value.length < 2048 ? URL.parse(value) : undefined
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port ||
      !/^i\d{1,2}\.hdslb\.com$/u.test(url.hostname) || !url.pathname.startsWith("/bfs/")) return
  url.protocol = "https:"
  return url.href
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
}

export function parseBiliPgcLink(value: string): BiliPgcTarget | undefined {
  const url = value.length <= 2048 && URL.parse(value.startsWith("www.") ? "https://" + value : value)
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port ||
      !hosts.has(url.hostname)) return
  const match = /^\/bangumi\/play\/(ep|ss)([1-9]\d{0,15})\/?$/u.exec(url.pathname)
  if (!match?.[2]) return
  const kind = match[1] === "ep" ? "ep" : "ss"
  return { kind, id: match[2], url: `${site}/bangumi/play/${kind}${match[2]}` }
}

function episode(raw: Fields): BiliPgcEpisode | undefined {
  const ep = id(raw.ep_id ?? raw.id)
  if (!ep || (raw.id !== undefined && id(raw.id) !== ep)) return
  const canonical = typeof raw.link === "string" ? parseBiliPgcLink(raw.link) : undefined
  if (raw.link !== undefined && canonical?.url !== `${site}/bangumi/play/ep${ep}`) return
  const label = text(raw.title, 50)
  const title = text(raw.long_title, 200)
  const duration = number(raw.duration)
  const name = /^\d+(?:\.\d+)?$/u.test(label) ? `第 ${label} 集` : label
  return { id: ep, cid: id(raw.cid), title: [name, title].filter(Boolean).join(" · "),
    cover: image(raw.cover), duration: duration && duration / 1000, badge: text(raw.badge, 24),
    status: raw.status, rights: fields(raw.rights) }
}

export function parseBiliPgcResponse(raw: unknown, target: BiliPgcTarget): BiliPgc | undefined {
  const body = fields(raw)
  const result = fields(body.result)
  const season = id(result.season_id)
  const title = text(result.title, 200)
  if (body.code !== 0 || !season || !title || (target.kind === "ss" && target.id !== season)) return
  const sections = Array.isArray(result.section) ? result.section.map(section => fields(section).episodes) : []
  const episodes = Array.isArray(result.episodes) ? result.episodes : []
  const rows = target.kind === "ss" ? episodes : [episodes, ...sections].flatMap(list => Array.isArray(list) ? list : [])
  const selected = target.kind === "ss" ? episode(fields(rows[0])) :
    rows.map(fields).filter(row => id(row.ep_id) === target.id || id(row.id) === target.id).map(episode)
  const match = Array.isArray(selected) ? selected[0] : selected
  if (Array.isArray(selected) && (!match || selected.some(row => !row || row.cid !== match.cid || row.title !== match.title ||
      row.status !== match.status || row.badge !== match.badge || row.duration !== match.duration ||
      row.rights.area_limit !== match.rights.area_limit || row.rights.allow_download !== match.rights.allow_download))) return
  const rating = fields(result.rating)
  const progress = fields(result.new_ep)
  const score = number(rating.score)
  const voters = number(rating.count)
  return { id: season, title, cover: image(result.cover), desc: text(result.evaluate, 800),
    update: [text(progress.desc, 100), text(progress.title, 100)].filter(Boolean).join(" · "),
    rating: score === undefined ? "" : `评分 ${score}${voters ? ` · ${voters} 人评分` : ""}`,
    stats: fields(result.stat), rights: fields(result.rights), episode: match }
}

export async function readBiliPgcJson(fetcher: BiliPgcFetch, endpoint: URL, referer: string, signal: AbortSignal) {
  const response = await fetcher(endpoint, { signal, redirect: "error", credentials: "omit",
    headers: { Accept: "application/json", Referer: referer } })
  if (!response.ok || response.redirected || !/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "") ||
      Number(response.headers.get("content-length")) > maxResponse || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("B 站番剧接口没有返回可用的公开数据。")
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    signal.throwIfAborted()
    size += chunk.length
    if (size > maxResponse) throw new Error("B 站番剧响应超过大小限制。")
    chunks.push(chunk)
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown
}

export async function fetchBiliPgc(target: BiliPgcTarget, fetcher: BiliPgcFetch, signal: AbortSignal) {
  const endpoint = new URL(api)
  endpoint.searchParams.set(target.kind === "ep" ? "ep_id" : "season_id", target.id)
  return parseBiliPgcResponse(await readBiliPgcJson(fetcher, endpoint, target.url, signal), target)
}

export async function loadBiliPgcSettings(root = deployment, video = config.settings) {
  const [rules, old] = await Promise.all([video("bilibili"),
    (async () => await readOptionalConfigFile(root, "plugins/rconsole-plugin/config/tools.yaml") ??
      await readOptionalConfigFile(root, "backup/plugins/rconsole-plugin/config/tools.yaml"))()])
  const duration = rules.biliPgcDuration ?? old?.biliBangumiDuration
  return { enable: rules.parseVideoLink && !(Array.isArray(old?.globalBlackList) && old.globalBlackList.includes("哔哩哔哩")),
    private: old?.privateResolve === true, automatic: rules.biliPgcAuto ?? (old?.biliBangumiDirect === true),
    quality: playbackQuality(rules.biliPgcQuality, old?.biliBangumiResolution),
    duration: typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0 ? duration : biliPgcDefaultDuration,
  }
}

export function createBiliPgcPreview({ signal, fetcher = fetch, options = loadBiliPgcSettings, render = renderTemplate, playback }: {
  readonly signal?: AbortSignal
  readonly fetcher?: BiliPgcFetch
  readonly options?: () => ReturnType<typeof loadBiliPgcSettings>
  readonly render?: typeof renderTemplate
  readonly playback?: Omit<NonNullable<Parameters<typeof createBiliPgcPlayback>[0]>, "fetcher">
}) {
  const play = createBiliPgcPlayback({ ...playback, fetcher })

  function target(message: string, context: MessageFallbackContext) {
    if (context.isDelegated || (context.message_type !== "group" && context.message_type !== "private")) return
    const command = playCommand.exec(message)
    if (command?.[1]) return parseBiliPgcLink(command[1])
    if (/^\s*[#＃]/u.test(message)) return
    const contents = buildMediaMessageText({ ...context, msg: message }).replaceAll("\\/", "/")
    for (const [value] of contents.matchAll(link)) {
      const target = parseBiliPgcLink(value.replace(/[.,!;]+$/u, ""))
      if (target) return target
    }
  }

  return {
    matches(message: string, context: MessageFallbackContext) { return !signal?.aborted && !!target(message, context) },
    features: ["[media] B 站解析", `[media] ${feature}`],
    async fallback(message: string, context: MessageFallbackContext): Promise<MessageReply | undefined> {
      const input = target(message, context)
      if (!input) return
      const scopes = [signal, context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal]
        .filter((scope): scope is AbortSignal => !!scope)
      const active = AbortSignal.any(scopes)
      if (active.aborted) return
      const explicit = playCommand.test(message)
      const rules = await options().catch(() => undefined)
      if (!rules?.enable || (!explicit && context.message_type === "private" && !rules.private) || active.aborted) return
      const unavailable = `暂无法读取 B 站番剧公开信息。\n${input.url}`
      try {
        const data = await fetchBiliPgc(input, fetcher, AbortSignal.any([active, AbortSignal.timeout(8000)]))
        if (active.aborted) return
        if (!data) return unavailable
        if (explicit) return play(input, data, context, rules, active, readBiliPgcJson)
        const selected = input.kind === "ep" ? data.episode : undefined
        const duration = selected?.duration ? `时长 ${Math.floor(selected.duration / 60)} 分 ${Math.floor(selected.duration % 60)} 秒` : ""
        const stat = data.stats
        const follows = number(stat.favorites)
        const followText = text(stat.follow_text, 50) || (follows === undefined ? "" : `追番 ${follows}`)
        const info = [selected?.title, selected?.badge && `平台标记 · ${selected.badge}`, duration,
          data.rating, data.update, followText, data.desc].filter(Boolean).join("\n")
        const card = { title: data.title, owner: "B 站番剧", id: `${input.kind}${input.id} · 全季统计`,
          type: "public-link", cover: selected?.cover ?? data.cover, desc: info,
          stat: { like: number(stat.likes), reply: number(stat.reply), favorite: number(stat.favorite),
            coin: number(stat.coins), view: number(stat.views), danmaku: number(stat.danmakus) } }
        const limit = context.inlineImageByteLimit ?? Infinity
        let image = await render("bilibili-info", card).catch(() => undefined)
        if (image && image.byteLength > limit && !active.aborted) image = await render("bilibili-info", card, { renderScale: 2 }).catch(() => undefined)
        if (active.aborted) return
        const preview: MessageReply = image && image.byteLength <= limit
          ? [{ type: "image", file: image }, { type: "text", text: input.url }]
          : [data.title, info, input.url].filter(Boolean).join("\n")
        if (!rules.automatic || !data.episode) return preview
        if (await context.reply(preview) && !active.aborted) return play(input, data, context, rules, active, readBiliPgcJson)
        return []
      } catch { if (!active.aborted) return unavailable }
    },
  }
}
