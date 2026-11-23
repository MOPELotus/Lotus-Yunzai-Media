import { nativeImageRasterScale } from "@lotus-yunzai/skia"
import type { MessageFallbackContext } from "../../../../../lib/commands.ts"
import { segment, type MessageReply } from "../../../../../lib/messages.ts"
import { renderSourceCard } from "../../../core/render/source-cards.ts"
import { buildMediaMessageText, isMediaCommandText } from "../../media/message.ts"
import type { SubscriptionSettings } from "../config.ts"
import { makeDynamicMessages } from "../render.ts"
import { fetchPublicWeiboComments, fetchPublicWeiboPost, weiboTypes, type WeiboPostIdentity, type WeiboPublicComment } from "./index.ts"

const feature = "[media] 微博解析"
const renderer = { id: "weibo", label: "微博", typeNames: weiboTypes } as const
const hostnames = new Set(["weibo.com", "www.weibo.com", "m.weibo.cn"])
const link = /(?<=^|[\s\p{Ps}\p{Pi}"'：，、；])https?:\/\/[^\s<>"'\p{Pe}\p{Pf}。，、！？；：]+/giu
const commentTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
})

function commentLine({ author, text, likes, createdAt, source }: WeiboPublicComment) {
  const details = [likes === undefined ? undefined : `赞 ${likes}`,
    createdAt === undefined ? undefined : commentTime.format(createdAt * 1000), source].filter(Boolean).join(" · ")
  return [author, text, details].filter(Boolean).join("\n")
}

function identify(message: string, context: MessageFallbackContext) {
  if (context.isDelegated || (context.message_type !== "group" && context.message_type !== "private") || isMediaCommandText(message)) return
  const contents = buildMediaMessageText({ ...context, msg: message }).replaceAll("\\/", "/")
  for (const [value] of contents.matchAll(link)) {
    const url = value.length <= 4096 && URL.parse(value.replace(/[.,!;]+$/u, ""))
    if (!url || url.username || url.password || url.port || !hostnames.has(url.hostname)) continue
    const mobile = url.hostname === "m.weibo.cn"
    const detail = mobile ? /^\/(?:status|detail)\/([A-Za-z0-9]{1,24})\/?$/u.exec(url.pathname) : undefined
    if (detail?.[1]) return { target: { id: detail[1] }, link: "https://m.weibo.cn/detail/" + detail[1] }
    const post = /^\/([1-9]\d{0,19})\/([A-Za-z0-9]{1,24})\/?$/u.exec(url.pathname)
    if (post?.[1] && post[2]) return { target: { uid: post[1], id: post[2] }, link: `https://weibo.com/${post[1]}/${post[2]}` }
    const mid = !mobile && /^\/tv\/show\/[\d:]+\/?$/u.test(url.pathname) && url.searchParams.get("mid")
    if (mid && /^[1-9]\d{0,19}$/u.test(mid)) return { target: { id: mid }, link: "https://m.weibo.cn/detail/" + mid }
  }
}

export function createWeiboPreview({ settings, signal, fetchPost = fetchPublicWeiboPost, fetchComments = fetchPublicWeiboComments,
  render = makeDynamicMessages, renderCommentCard = renderSourceCard }: {
  readonly settings: () => Promise<SubscriptionSettings>
  readonly signal?: AbortSignal
  readonly fetchPost?: (target: WeiboPostIdentity, signal?: AbortSignal) => ReturnType<typeof fetchPublicWeiboPost>
  readonly fetchComments?: typeof fetchPublicWeiboComments
  readonly render?: typeof makeDynamicMessages
  readonly renderCommentCard?: typeof renderSourceCard
}) {
  async function commentMessages(comments: readonly WeiboPublicComment[], picture: boolean, inlineLimit: number, active?: AbortSignal) {
    const messages: MessageReply[] = []
    const rows = comments.slice(0, 20).map(commentLine)
    for (let index = 0; index < rows.length && !active?.aborted; index += 5) {
      const items = rows.slice(index, index + 5)
      const title = `微博热评 · ${index + 1}–${index + items.length} / ${rows.length}`
      let file: Uint8Array | undefined
      // The shared renderer already applies the low preset to the requested canvas size.
      const scales = nativeImageRasterScale() === 4 ? [4, 2] : [4]
      for (const renderScale of picture ? scales : []) {
        if (active?.aborted) break
        try {
          const png = await renderCommentCard("status", { title, items }, { renderScale })
          if (png.length > inlineLimit) continue
          file = png
          break
        } catch { /* Keep the readable comments when rendering fails. */ }
      }
      messages.push(file ? segment.image(file) : segment.text([title, ...items].join("\n\n")))
    }
    return messages
  }
  return {
    features: (context: MessageFallbackContext) => !signal?.aborted && identify(context.normalizedMessage, context) ? [feature] : [],
    async fallback(message: string, context: MessageFallbackContext) {
      const input = identify(message, context)
      if (!input) return
      const scopes = [signal, context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal]
        .filter((scope): scope is AbortSignal => !!scope)
      const active = scopes.length ? AbortSignal.any(scopes) : undefined
      try {
        if (active?.aborted) return
        const options = await settings()
        if (!options.parseWeiboLink || (context.message_type === "private" && !options.parseWeiboPrivate) || active?.aborted) return
        const post = await fetchPost(input.target, active)
        if (active?.aborted) return
        if (!post) return `微博暂时无法匿名读取这条动态，请打开原文查看。\n${input.link}`
        const comments = options.weiboComments && post.id && post.activity?.comments !== "0"
          ? fetchComments(post.id, active).catch(() => []) : []
        const messages = await render(renderer, post, options, { signal: active, inlineImageByteLimit: context.inlineImageByteLimit, preview: true })
        if (active?.aborted) return
        const extra = await commentMessages(await comments, options.picture, context.inlineImageByteLimit ?? Infinity, active)
        if (active?.aborted) return
        const nodes = [...(messages.length ? messages : [input.link]), ...extra]
        if (nodes.length > 1) return { type: "forward" as const, nodes }
        return nodes[0]
      } catch {
        if (!active?.aborted) return `暂时无法生成微博预览，请打开原文查看。\n${input.link}`
      }
    },
  }
}
