import { load } from "cheerio"
import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import type { MessageReply } from "../../../../lib/messages.ts"
import { requestOfficialJson } from "../../../../packages/hoyo-client/redeem-preview/http.ts"
import { renderSourceCard } from "../../core/render/source-cards.ts"
import { articlePages, buildMediaMessageText, isMediaCommandText, type ArticleBlock } from "../media/message.ts"

const link = /(?<=^|[\s"'([{>：，。])https?:\/\/(?:www\.|m\.)?miyoushe\.com\/[a-z0-9]+\/article\/([1-9]\d{0,17})(?=$|[\s"'\])}<>,.?/#&，。！？；：])/iu
const imagesHosts = new Set(["upload-bbs.miyoushe.com", "upload-bbs.mihoyo.com"])

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, length: number) {
  return typeof value === "string" ? Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim()).slice(0, length).join("") : ""
}

function sourceUrl(value: unknown) {
  const url = typeof value === "string" && value.length <= 2048 ? URL.parse(value) : undefined
  if (url?.protocol === "https:" && !url.username && !url.password && !url.port) return url
}

function picture(value: unknown) {
  const url = sourceUrl(value)
  if (url && imagesHosts.has(url.hostname)) return url.href
}

function contentBlocks(post: Record<string, unknown>) {
  const blocks: ArticleBlock[] = []
  const seen = new Set<string>()
  function pushPicture(value: unknown) {
    const url = picture(value)
    if (!url || seen.has(url) || seen.size >= 20) return
    seen.add(url)
    blocks.push({ type: "image", urls: [url] })
  }
  let remaining = 6000
  function pushText(value: unknown) {
    const body = text(value, remaining)
    if (!body) return
    remaining -= Array.from(body).length
    blocks.push({ type: "text", text: body })
  }
  if (typeof post.structured_content === "string" && post.structured_content.length <= 120_000) {
    try {
      const rows: unknown = JSON.parse(post.structured_content)
      if (Array.isArray(rows)) {
        let paragraph = ""
        for (const raw of rows.slice(0, 500)) {
          const insert = record(raw).insert
          if (typeof insert === "string") paragraph += insert
          else {
            pushText(paragraph)
            paragraph = ""
            pushPicture(record(insert).image)
          }
        }
        pushText(paragraph)
      }
    } catch { /* Use the post's plain content when delta is unavailable. */ }
  }
  if (!blocks.some(block => block.type === "text") && typeof post.content === "string" && post.content.length <= 120_000) {
    try { pushText(record(JSON.parse(post.content)).describe) }
    catch {
      const document = load(post.content, undefined, false)
      document("script,style").remove()
      document("br").replaceWith("\n")
      document("p,li").append("\n")
      pushText(document.root().text())
    }
  }
  if (Array.isArray(post.images)) for (const url of post.images.slice(0, 20)) pushPicture(url)
  return blocks
}

export function createMiyoushePostCommands({ signal, request = requestOfficialJson, render = renderSourceCard }: {
  readonly signal?: AbortSignal; readonly request?: typeof requestOfficialJson; readonly render?: typeof renderSourceCard
} = {}) {
  function identify(message: string, context: MessageFallbackContext) {
    if (signal?.aborted || context.isDelegated || context.message_type === "terminal" || isMediaCommandText(message)) return
    return link.exec(buildMediaMessageText({ ...context, msg: message }))
  }

  async function fallback(message: string, context: MessageFallbackContext) {
    const matched = identify(message, context)
    if (!matched?.[1]) return
    const id = matched[1]
    const source = new URL(matched[0])
    source.protocol = "https:"
    const target = new URL("https://bbs-api.mihoyo.com/post/wapi/getPostFull")
    target.search = new URLSearchParams({ post_id: id, read: "0" }).toString()
    try {
      const response = record(await request(target, { signal, headers: { Accept: "application/json", Referer: "https://www.miyoushe.com/" } }))
      const entry = record(record(response.data).post)
      const post = record(entry.post)
      if (response.retcode !== 0 || String(post.post_id) !== id) return "米游社没有返回匹配的公开帖子。"
      const owner = text(record(entry.user).nickname, 80)
      const title = text(post.subject, 160) || "米游社帖子"
      const blocks = contentBlocks(post)
      const cover = picture(post.cover)
      if (cover && !blocks.some(block => block.urls?.includes(cover))) blocks.unshift({ type: "image", urls: [cover] })
      const pages = articlePages({ blocks })
      const intro = `${title}\n${[owner, source.href].filter(Boolean).join("\n")}`
      const nodes: MessageReply[] = [intro]
      const inlineLimit = context.inlineImageByteLimit ?? 16 * 1024 * 1024
      for (const [index, page] of pages.entries()) {
        signal?.throwIfAborted()
        const original = page[0]?.type === "image" ? page[0].urls?.[0] : undefined
        const card = { title, owner, page: index + 1, blocks: page }
        let image = await render("article", card).catch(() => undefined)
        if (image && image.byteLength > inlineLimit && Number(Bun.env.LOTUS_RENDER_SCALE ?? 4) > 2) {
          image = await render("article", card, { renderScale: 2 }).catch(() => undefined)
        }
        if (image && image.byteLength <= inlineLimit) nodes.push(original ? [{ type: "image", file: image }, `原图：${original}`] : { type: "image", file: image })
        else nodes.push(page.map(block => block.text ?? block.urls?.join("\n")).filter(Boolean).join("\n"))
      }
      const videos = Array.isArray(entry.vod_list) ? entry.vod_list : []
      const resolutions = record(videos[0]).resolutions
      if (Array.isArray(resolutions)) {
        const video = resolutions.map(row => sourceUrl(record(row).url)).find(url => url && /(?:^|\.)mihoyo\.com$|(?:^|\.)miyoushe\.com$/u.test(url.hostname))
        if (video) nodes.push(`视频地址：${video.href}`)
      }
      signal?.throwIfAborted()
      return nodes.length > 1 ? { type: "forward" as const, nodes } : intro
    } catch { if (!signal?.aborted) return "暂时无法读取米游社公开帖子。" }
  }

  return { fallback, features: (context: MessageFallbackContext) => identify(context.normalizedMessage, context) ? ["[media] 米游社帖子"] : [] }
}
