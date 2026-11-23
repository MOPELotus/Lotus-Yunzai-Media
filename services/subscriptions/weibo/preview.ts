import type { MessageFallbackContext } from "../../../../../lib/commands.ts"
import { buildMediaMessageText, isMediaCommandText } from "../../media/message.ts"
import type { SubscriptionSettings } from "../config.ts"
import { makeDynamicMessages } from "../render.ts"
import { fetchPublicWeiboPost, weiboTypes, type WeiboPostIdentity } from "./index.ts"

const feature = "[media] 微博解析"
const renderer = { id: "weibo", label: "微博", typeNames: weiboTypes } as const
const hostnames = new Set(["weibo.com", "www.weibo.com", "m.weibo.cn"])
const link = /(?<=^|[\s\p{Ps}\p{Pi}"'：，、；])https?:\/\/[^\s<>"'\p{Pe}\p{Pf}。，、！？；：]+/giu

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

export function createWeiboPreview({ settings, signal, fetchPost = fetchPublicWeiboPost, render = makeDynamicMessages }: {
  readonly settings: () => Promise<SubscriptionSettings>
  readonly signal?: AbortSignal
  readonly fetchPost?: (target: WeiboPostIdentity, signal?: AbortSignal) => ReturnType<typeof fetchPublicWeiboPost>
  readonly render?: typeof makeDynamicMessages
}) {
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
        const messages = await render(renderer, post, options, { signal: active, inlineImageByteLimit: context.inlineImageByteLimit, preview: true })
        if (active?.aborted) return
        if (messages.length > 1) return { type: "forward" as const, nodes: messages }
        return messages[0] ?? input.link
      } catch {
        if (!active?.aborted) return `暂时无法生成微博预览，请打开原文查看。\n${input.link}`
      }
    },
  }
}
