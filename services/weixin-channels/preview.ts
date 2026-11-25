import { withoutReadRetries, withReadRetries } from "@lotus-yunzai/http"
import { readPublicResponse } from "../public-read.ts"
import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { loadPublicShareConfig } from "../../core/config/global.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderSourceCard } from "../../core/render/source-cards.ts"
import { buildMediaMessageText, isMediaCommandText } from "../media/message.ts"
import { weixinChannelsImageUrl } from "../media/cdn.ts"

const origin = "https://channels.weixin.qq.com"
const page = origin + "/finder-preview/pages/sph"
const endpoint = origin + "/finder-preview/api/feed/get_feed_info"
const label = "视频号"
const maxResponseBytes = 128 * 1024

function shareId(value: string) {
  const url = URL.parse(value)
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port || url.hash) return
  const id = url.hostname === "weixin.qq.com" ? /^\/sph\/([A-Za-z0-9]{6,64})\/?$/u.exec(url.pathname)?.[1]
    : url.origin === origin && url.pathname === "/finder-preview/pages/sph" && url.searchParams.getAll("id").length === 1
      ? url.searchParams.get("id") : undefined
  if (id && /^[A-Za-z0-9]{6,64}$/u.test(id)) return id
}

function sharedId(message: string, context: MessageFallbackContext) {
  if (context.isDelegated || (context.message_type !== "group" && context.message_type !== "private") || isMediaCommandText(message)) return
  const text = buildMediaMessageText({ ...context, msg: message }).replaceAll("\\/", "/")
  for (const [url] of text.matchAll(/https?:\/\/[^\s<>"'，。！？；）】]+/giu)) {
    const id = shareId(url.replace(/[),.]+$/u, ""))
    if (id) return id
  }
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, limit: number) {
  return typeof value === "string" ? Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").trim())
    .slice(0, limit).join("") : ""
}

function count(value: unknown) {
  if (typeof value === "string" && /^\d{1,10}(?:\.\d{1,2}[万亿]|[万亿])?$/u.test(value)) return value
}

async function readJson(response: Response) {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxResponseBytes ||
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel().catch(() => {})
    return
  }
  let size = 0, json = ""
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > maxResponseBytes) throw new Error("视频号预览响应大小超过限制")
    json += decoder.decode(chunk, { stream: true })
  }
  return fields(JSON.parse(json + decoder.decode()))
}

async function readPreview(id: string, url: string, active: AbortSignal, fetch: typeof globalThis.fetch) {
  const signal = AbortSignal.any([active, AbortSignal.timeout(8_000)])
  const options = { credentials: "omit", redirect: "manual", signal } as const
  // The public short link must resolve to the official preview page for this exact ID.
  const redirect = await readPublicResponse(fetch, url, options)
  await redirect.body?.cancel()
  const target = URL.parse(redirect.headers.get("location") ?? "")
  if (![301, 302, 303, 307, 308].includes(redirect.status) || target?.origin !== origin || shareId(target.href) !== id) return

  const read = withReadRetries((target, init) => withoutReadRetries(() => fetch(target.href, init)), {
    canRetry: (target, method) => method === "POST" && target.href === endpoint,
  })
  const response = await read(new URL(endpoint), {
    ...options, method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Referer: page + "?id=" + id },
    body: JSON.stringify({ baseReq: { generalToken: "" }, shortUri: id }),
  })
  const body = await readJson(response)
  const data = fields(body?.data)
  const scene = fields(data.sceneInfo)
  const identity = scene.dynamicExportId
  if (body?.errCode !== 0 || fields(data.errMsg).type !== 0 || typeof identity !== "string" ||
      !/^export\/[A-Za-z0-9_-]{20,128}$/u.test(identity)) return
  const feed = fields(data.feedInfo)
  const author = fields(data.authorInfo)
  const title = text(feed.description, 200) || "视频号分享"
  const owner = text(author.nickname, 80)
  if (!owner || typeof feed.description !== "string" || feed.isHardAd !== false) return
  const cover = typeof feed.coverUrl === "string" ? weixinChannelsImageUrl(feed.coverUrl, "cover")?.href : undefined
  const avatar = typeof author.headImgUrl === "string" ? weixinChannelsImageUrl(author.headImgUrl, "avatar")?.href : undefined
  const time = feed.createtime
  const createdAt = typeof time === "number" && Number.isSafeInteger(time) && time > 0 && time < 4_102_444_800 ? time : undefined
  const stat = {
    like: count(feed.favCountFmt), reply: count(feed.commentCountFmt),
    favorite: count(feed.likeCountFmt), share: count(feed.forwardCountFmt),
  }
  return { title, owner, cover, avatar, createdAt, stat }
}

export function createWeixinChannelsPreview({ signal, fetch = globalThis.fetch, loadConfig = loadPublicShareConfig,
  render = renderSourceCard }: {
  readonly signal?: AbortSignal
  readonly fetch?: typeof globalThis.fetch
  readonly loadConfig?: typeof loadPublicShareConfig
  readonly render?: typeof renderSourceCard
} = {}) {
  return {
    features(context: MessageFallbackContext) {
      return sharedId(context.normalizedMessage, context) ? ["[media] 视频号分享"] : []
    },
    async fallback(message: string, context: MessageFallbackContext) {
      const id = sharedId(message, context)
      if (!id) return
      const connection = context.message_type === "private" ? context.privateCredentialSignal : context.groupActivitySignal
      if (context.message_type === "private" && !connection) return
      const signals = [signal, connection].filter((value): value is AbortSignal => value !== undefined)
      const active = AbortSignal.any(signals)
      if (active.aborted) return []
      const url = "https://weixin.qq.com/sph/" + id
      const unavailable = "暂时无法读取视频号公开预览，请打开原链接。\n" + url
      try {
        const config = await loadConfig("wxchannels")
        if (active.aborted) return []
        if (!config.enable || context.message_type === "private" && !config.privatePreview ||
            !new PermissionService({ permissions: config.permissions }).can(context, "wxchannels.preview")) return
        const result = await readPreview(id, url, active, fetch)
        if (active.aborted) return []
        if (!result) return unavailable
        const card = { ...result, id: label, type: "share" }
        const limit = context.inlineImageByteLimit ?? 16 * 1024 * 1024
        let image = await render("weixin-channels-info", card).catch(() => undefined)
        if (image && image.byteLength > limit && Number(Bun.env.LOTUS_RENDER_SCALE ?? 4) > 2 && !active.aborted) {
          image = await render("weixin-channels-info", card, { renderScale: 2 }).catch(() => undefined)
        }
        if (active.aborted) return []
        const source = "在微信中观看\n" + url
        return image && image.byteLength <= limit ? [{ type: "image" as const, file: image }, source]
          : [label + " · " + result.title, result.owner, source].join("\n")
      } catch {
        return active.aborted ? [] : unavailable
      }
    },
  }
}
