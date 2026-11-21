import type { CommandReply } from "../../../../lib/commands.ts"
import type { MessageReply } from "../../../../lib/messages.ts"
import { mcWikiTitle, readMcWikiArticle, type McWikiArticle } from "./article.ts"
import { renderMcWikiArticle } from "./render.ts"

const missing = "搜索不到此结果，请检查关键词是否准确无误"

type Preview = { readonly png: Uint8Array; readonly engine?: Awaited<ReturnType<typeof renderMcWikiArticle>>["engine"] }

interface McWikiCommandOptions {
  readonly signal?: AbortSignal
  readonly read?: typeof readMcWikiArticle
  readonly render?: (article: McWikiArticle) => Promise<Preview>
}

export function createMcWikiCommand({ signal, read = readMcWikiArticle, render = renderMcWikiArticle }: McWikiCommandOptions = {}) {
  return async function mcWiki(argument: string): Promise<CommandReply | undefined> {
    const title = mcWikiTitle(argument)
    if (!title) return "用法：#mcwiki 条目名称"
    const result = await read(title, { signal })
    if (signal?.aborted) return
    if (result.status === "missing") return missing
    const nodes: MessageReply[] = [result.url]
    if (result.status === "article") {
      const article = result.article
      let card: Preview | undefined
      try {
        card = await render(article)
        if (card?.engine) {
          const engine = card.engine
          console.info(`[media] Minecraft Wiki 条目预览使用 ${engine.renderer} / ${engine.api ?? "未知后端"} / ${engine.device ?? "未知设备"}`)
        }
      } catch {
        // The verified canonical link remains usable when the preview fails.
      }
      if (signal?.aborted) return
      if (card?.png?.byteLength) nodes.push({ type: "image", file: card.png })
      else nodes.push("条目预览暂时无法生成，请打开原文。")
      nodes.push(`来源：中文 Minecraft Wiki 贡献者（修订 ${article.revisionId}）\n${article.revisionUrl}\n正文许可：CC BY-NC-SA 3.0，例外见原文。\n${article.license}`)
    } else {
      nodes.push("条目预览暂时无法读取，请打开链接。")
    }
    return { type: "forward", nodes }
  }
}
