import { load } from "cheerio"
import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import type { MessageReply } from "../../../../lib/messages.ts"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { fetchImageBytes } from "../../core/render/image.ts"
import { renderSourceCard } from "../../core/render/source-cards.ts"
import { jikeImageUrl, type MediaFetch } from "../media/cdn.ts"
import { sniffMedia } from "../media/download.ts"
import { buildMediaMessageText, isMediaCommandText, type ArticleBlock } from "../media/message.ts"
import { readPublicSharePage } from "../public-share/page.ts"
import { createJikeSettings } from "./settings.ts"

const link = /(?<=^|[\s"'([{>：，。])https?:\/\/m\.okjike\.com\/originalPosts\/[a-f\d]{24}(?=$|[\s"'\])}<>,.?/#&，。！？；：])/u
const feature = "[media] 即刻解析"
const oneMiB = 1024 * 1024

function row(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, limit: number) {
  return typeof value === "string"
    ? Array.from(value.replace(/[^\S\n]+/gu, " ").replace(/[\p{Cf}\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu, "").trim()).slice(0, limit).join("")
    : ""
}

function postId(url: URL) {
  return url.origin === "https://m.okjike.com" && !url.username && !url.password
    ? /^\/originalPosts\/([0-9a-f]{24})\/?$/u.exec(url.pathname)?.[1] : undefined
}

export function parseJikePost(html: string, id: string) {
  const $ = load(html)
  const json = $('script#__NEXT_DATA__[type="application/json"]').first().text()
  if (!json) return
  const post = row(row(row(row(JSON.parse(json)).props).pageProps).post)
  if (post.id !== id || post.type !== "ORIGINAL_POST" || post.status !== "NORMAL" || post.isSuppressed === true) return
  const pictures = [...new Set((Array.isArray(post.pictures) ? post.pictures : []).slice(0, 18).flatMap(item =>
    jikeImageUrl(text(row(item).picUrl, 4096))?.href ?? []))]
  const video = row(post.video)
  const videoCover = jikeImageUrl(text(row(video.image).picUrl, 4096))?.href
  const duration = typeof video.duration === "number" && Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration / 1_000) : undefined
  const body = text(post.content, 6_000)
  return { body, title: text(body.split("\n", 1)[0], 72) || "即刻动态", owner: text(row(post.user).screenName, 80),
    pictures, hasVideo: Object.keys(video).length > 0, videoCover, duration }
}

export function createJikeCommands({ signal, fetch = globalThis.fetch, render = renderSourceCard,
  loadConfig = loadGlobalConfig, settings = createJikeSettings() }: {
  readonly signal?: AbortSignal
  readonly fetch?: MediaFetch
  readonly render?: typeof renderSourceCard
  readonly loadConfig?: typeof loadGlobalConfig
  readonly settings?: ReturnType<typeof createJikeSettings>
} = {}) {
  function identify(message: string, context: MessageFallbackContext) {
    if (signal?.aborted || context.isDelegated || context.message_type === "terminal" || isMediaCommandText(message)) return
    const url = URL.parse(link.exec(buildMediaMessageText({ ...context, msg: message }))?.[0] ?? "")
    if (!url) return
    url.protocol = "https:"
    return postId(url) ? url : undefined
  }

  async function originalPictures(urls: readonly string[], limit: number, signal: AbortSignal) {
    const pictures: MessageReply[] = []
    let remaining = 20 * oneMiB
    for (const picture of urls) {
      signal.throwIfAborted()
      if (!remaining) break
      try {
        const bytes = await fetchImageBytes(picture, {
          maxBytes: Math.min(remaining, limit, 10 * oneMiB), timeoutMs: 5_000,
          fetch: (url, options) => fetch(url, { ...options, credentials: "omit",
            signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal }),
        })
        if (sniffMedia(bytes)?.kind !== "image") continue
        pictures.push({ type: "image", file: bytes })
        remaining -= bytes.byteLength
      } catch { /* Other publicly visible images can still be delivered. */ }
    }
    signal.throwIfAborted()
    if (urls.length !== pictures.length) pictures.push("部分原图未能读取，可打开上面的即刻原帖。")
    return { pictures, forward: pictures.length >= 4 || remaining < 12 * oneMiB }
  }

  const fallback: MessageFallback = async (message, context) => {
    const source = identify(message, context)
    if (!source) return
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
    const lifetime = [signal, connection].filter((value): value is AbortSignal => value !== undefined)
    const active = AbortSignal.any([...lifetime, AbortSignal.timeout(20_000)])
    try {
      const options = await settings.settings((await loadConfig()).tools)
      if (!options.enable || (context.message_type === "private" && !options.private)) return
      const id = postId(source)!
      const page = await readPublicSharePage(source, url => postId(url) === id, fetch, active)
      const post = page && parseJikePost(page.html, id)
      if (!post) return "即刻未返回该公开动态。"
      const video = post.hasVideo ? `视频原帖${post.duration ? ` · ${post.duration} 秒` : ""}` : ""
      const meta = ["即刻", post.owner && `作者：${post.owner}`, video, source.href].filter(Boolean).join("\n")
      const full = [meta, post.body].filter(Boolean).join("\n")
      const blocks: ArticleBlock[] = [{ type: "text", text: Array.from(post.body).slice(0, 450).join("") || video || "即刻动态" }]
      if (post.videoCover) blocks.push({ type: "image", urls: [post.videoCover] })
      const limit = context.inlineImageByteLimit ?? 16 * oneMiB
      const card = await render("article", { title: post.title, owner: post.owner, page: 1, blocks }).catch(() => undefined)
      active.throwIfAborted()
      const intro: MessageReply = card && card.byteLength <= limit
        ? [{ type: "image", file: card }, post.body.length > 450 ? full : meta] : full
      const { pictures, forward } = await originalPictures(post.pictures, limit, active)
      return forward ? { type: "forward", nodes: [intro, ...pictures] } : [intro, ...pictures].flat()
    } catch { if (!lifetime.some(value => value.aborted)) return "暂时无法读取即刻公开动态。" }
  }

  return { fallback, features: (context: MessageFallbackContext) => identify(context.normalizedMessage, context) ? [feature] : [] }
}
