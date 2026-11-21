import type { InboundSegment } from "../../../../lib/messages.ts"

interface MediaText {
  readonly message?: string | readonly InboundSegment[]
  readonly raw_message?: string
  readonly msg?: string
}

export interface ArticleBlock {
  readonly type: "text" | "image"
  readonly text?: string
  readonly urls?: readonly string[]
  readonly caption?: string
}

/** Leave explicit media commands to their registered handlers. */
export function isMediaCommandText(message = "") {
  return /^#[\p{L}\p{N}_-]*?(?:(?:搜视频|看视频|点歌|搜歌)|(?:下载|下视频|音乐登录)(?=\s|$))/u.test(message)
}

export function buildMediaMessageText(e: MediaText = {}) {
  const chunks: unknown[] = []
  for (const item of Array.isArray(e.message) ? e.message : []) {
    if ((item?.type === "json" || item?.type === "xml" || item?.type === "light_app" || item?.type === "share") && item.data) chunks.push(typeof item.data === "string" ? item.data : JSON.stringify(item.data))
    if (item?.type === "text") {
      const data = item.data
      chunks.push(item.text || (data && typeof data === "object" && "text" in data ? data.text : undefined))
    }
  }
  chunks.push(e.raw_message, e.msg)
  return [...new Set(chunks.filter(Boolean))].join("\n")
}

/** Bounded card sizes without discarding any article text or image ordering. */
export function articlePages(article: { readonly blocks: readonly ArticleBlock[] } | undefined) {
  if (!article) return []
  const pages: ArticleBlock[][] = []
  let page: ArticleBlock[] = []
  let length = 0
  const flush = () => { if (page.length) pages.push(page); page = []; length = 0 }
  for (const block of article.blocks) {
    if (block.type === "image") { flush(); pages.push([block]); continue }
    const units = Array.from(block.text || "")
    while (units.length) {
      const text = units.splice(0, 600 - length).join("")
      page.push({ type: "text", text })
      length += Array.from(text).length
      if (length >= 600) flush()
    }
  }
  flush()
  return pages
}
