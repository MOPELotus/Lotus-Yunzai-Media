import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import type { CommandReply } from "../../../../lib/commands.ts"
import type { MessageReply } from "../../../../lib/messages.ts"
import { mcWikiTitle, readMcWikiArticle, type McWikiArticle } from "./article.ts"
import { renderMcWikiArticle } from "./render.ts"

const missing = $t("services.mcwiki.command.text_93c42a1e96")

type Preview = { readonly png: Uint8Array; readonly engine?: Awaited<ReturnType<typeof renderMcWikiArticle>>["engine"] }

interface McWikiCommandOptions {
  readonly signal?: AbortSignal
  readonly read?: typeof readMcWikiArticle
  readonly render?: (article: McWikiArticle) => Promise<Preview>
}

export function createMcWikiCommand({ signal, read = readMcWikiArticle, render = renderMcWikiArticle }: McWikiCommandOptions = {}) {
  return async function mcWiki(argument: string): Promise<CommandReply | undefined> {
    const title = mcWikiTitle(argument)
    if (!title) return $t("services.mcwiki.command.text_21cc7db973")
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
          console.info($t("services.mcwiki.command.text_77d2715f65", { "renderer": engine.renderer, "value2": engine.api ?? $t("services.mcwiki.command.text_9a031440b6"), "value3": engine.device ?? $t("services.mcwiki.command.text_8ca01a9ba4") }))
        }
      } catch {
        // The verified canonical link remains usable when the preview fails.
      }
      if (signal?.aborted) return
      if (card?.png?.byteLength) nodes.push({ type: "image", file: card.png })
      else nodes.push($t("services.mcwiki.command.text_aef89a4260"))
      nodes.push($t("services.mcwiki.command.text_ff8fa218d9", { "revisionId": article.revisionId, "revisionUrl": article.revisionUrl, "license": article.license }))
    } else {
      nodes.push($t("services.mcwiki.command.text_bc66d98a1f"))
    }
    return { type: "forward", nodes }
  }
}
