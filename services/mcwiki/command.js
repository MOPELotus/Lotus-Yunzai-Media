import { mcWikiTitle, readMcWikiArticle } from "./article.js"
import { renderMcWikiArticle } from "./render.js"

const missing = "搜索不到此结果，请检查关键词是否准确无误"

export function createMcWikiCommand({ signal, read = readMcWikiArticle, render = renderMcWikiArticle } = {}) {
  return async function mcWiki(argument) {
    const title = mcWikiTitle(argument)
    if (!title) return "用法：#mcwiki 条目名称"
    const result = await read(title, { signal })
    if (signal?.aborted) return
    if (result.status === "missing") return missing
    const nodes = [result.url]
    if (result.status === "article") {
      const article = result.article
      let card
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
