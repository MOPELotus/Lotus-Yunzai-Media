import type { CommandForward, CommandReply, MessageFallbackContext } from "../../../../lib/commands.ts"
import { renderTemplate } from "../../core/render/service.ts"
import { messageLinkValues } from "../official-links/command.ts"
import { createOfficialLinkSettings } from "../official-links/settings.ts"
import { getV2exArticle, parseOfficialLink, type OfficialLink, type OfficialLinkFetch } from "../official-links/source.ts"
import { createSummaryModel, maxSummaryInput } from "../official-links/summary-model.ts"
import { getArxiv, parseArxiv, type ArxivTarget } from "./arxiv.ts"
import { getOfficialArticle, parseOfficialArticle } from "./official-article.ts"
import { createPublicPageReader } from "./public-page.ts"
import { parsePublicPageUrl } from "./public-page-network.ts"

type GenericPage = { readonly source: "public-page"; readonly link: string }
type Source = GenericPage | ArxivTarget | NonNullable<ReturnType<typeof parseOfficialArticle>> | Extract<OfficialLink, { platform: "v2ex" }>
type Summary = Pick<ReturnType<typeof createSummaryModel>, "settings" | "summarize">
const explicitSummary = /^\s*[#＃]总结一下(?=\s|https?:\/\/|$)/iu

function parse(value: string): Source | undefined {
  const article = parseArxiv(value) ?? parseOfficialArticle(value)
  if (article) return article
  const link = parseOfficialLink(value)
  if (link?.platform === "v2ex") return link
}

function identify(message: string, context: MessageFallbackContext) {
  if (context.isDelegated || (context.message_type !== "private" && context.message_type !== "group")) return
  if (/^\s*[#＃]/u.test(message)) {
    if (!explicitSummary.test(message)) return
    const value = /^(https?:\/\/\S+)$/iu.exec(message.replace(explicitSummary, "").trim())?.[1]
    if (value) {
      const fixed = parse(value)
      if (fixed) return fixed
      const url = parsePublicPageUrl(value)
      if (url) return { source: "public-page", link: value } as const
    }
    return
  }
  for (const value of messageLinkValues(message, context)) {
    const target = parse(value)
    if (target) return target
  }
}

function isGenericPage(target: Source): target is GenericPage {
  return "source" in target && target.source === "public-page"
}

async function getArticle(target: Exclude<Source, GenericPage>, fetcher: OfficialLinkFetch, signal: AbortSignal) {
  if ("platform" in target) return getV2exArticle(target, fetcher, signal)
  if (target.source === "arxiv") return getArxiv(target, fetcher, signal)
  return getOfficialArticle(target, fetcher, signal)
}

function summaryReply(title: string, owner: string | undefined, text: string, source: string, original: string, excerpt: string,
  yuanbaoFallback: boolean): CommandForward {
  const chars = Array.from(text)
  const units = Array.from(original).length
  const minutes = Math.max(1, Math.ceil(units / 500))
  const nodes = [`《${title}》 · 原文 ${units} 字 · 预计阅读 ${minutes} 分钟`, ...(owner ? [owner] : [])]
  if (yuanbaoFallback) nodes.push("本次使用已配置的通用模型生成摘要。")
  if (excerpt.length < original.length) nodes.push(`摘要依据开头 ${Array.from(excerpt).length} 字，完整内容请查看原文。`)
  for (let offset = 0; offset < chars.length; offset += 900) nodes.push(chars.slice(offset, offset + 900).join(""))
  nodes.push(source)
  return { type: "forward", nodes }
}

export function createWebSummary({
  signal, settings = createOfficialLinkSettings().settings, model = createSummaryModel(),
  fetcher = fetch, render = renderTemplate, publicPage = createPublicPageReader(),
}: {
  readonly signal?: AbortSignal
  readonly settings?: ReturnType<typeof createOfficialLinkSettings>["settings"]
  readonly model?: Summary
  readonly fetcher?: OfficialLinkFetch
  readonly render?: typeof renderTemplate
  readonly publicPage?: ReturnType<typeof createPublicPageReader>
} = {}) {
  return {
    matches(message: string) {
      return explicitSummary.test(message)
    },
    features(context: MessageFallbackContext) {
      const target = !signal?.aborted && identify(context.normalizedMessage, context)
      return target ? ["platform" in target ? "[media] V2EX 预览" : "[media] 网页总结"] : []
    },
    async fallback(message: string, context: MessageFallbackContext): Promise<CommandReply | undefined> {
      const target = identify(message, context)
      if (!target || signal?.aborted) return
      const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
      const active = AbortSignal.any([signal, connection].filter((value): value is AbortSignal => !!value))
      const options = await settings(false).catch(() => undefined)
      const v2ex = "platform" in target
      if (!options?.[v2ex ? "v2ex" : "articles"] || active.aborted ||
          (context.message_type === "private" && !options.private)) return []
      const generic = isGenericPage(target)
      const genericConfiguration = generic ? await model.settings().catch(() => undefined) : undefined
      if (generic && !genericConfiguration) return `暂无法读取公开原文。\n${target.link}`
      let article
      try {
        const deadline = AbortSignal.any([active, AbortSignal.timeout(8000)])
        article = generic ? await publicPage(target.link, deadline, genericConfiguration?.summaryBaseUrl)
          : await getArticle(target, fetcher, deadline)
      }
      catch { if (active.aborted) return [] }
      if (active.aborted) return []
      if (!article) return `暂无法读取公开原文。\n${target.link}`
      const configuration = generic ? genericConfiguration : await model.settings().catch(() => undefined)
      if (article.text && configuration?.summaryEnabled && !active.aborted) {
        try {
          const fallback = configuration.summaryMode === "yuanbao"
          const excerpt = article.text.slice(0, maxSummaryInput).toWellFormed()
          const summary = await model.summarize({ title: article.title.slice(0, 500).toWellFormed(), text: excerpt }, active, fallback)
          if (!active.aborted && summary) return summaryReply(article.title, article.owner, summary, article.link, article.text, excerpt, fallback)
        } catch { if (active.aborted) return [] }
      }
      if (active.aborted) return []
      const chars = Array.from(article.text)
      const desc = chars.length > 1200 ? chars.slice(0, 1200).join("") + "…" : article.text
      const card = { title: article.title, owner: article.owner, desc, id: v2ex ? `V2EX · ${target.id}` : "原文摘录",
        type: "public-link", showStats: false }
      const limit = context.inlineImageByteLimit ?? Infinity
      let image = await render("bilibili-info", card).catch(() => undefined)
      if (image && image.byteLength > limit && !active.aborted) image = await render("bilibili-info", card, { renderScale: 2 }).catch(() => undefined)
      if (active.aborted) return []
      if (image && image.byteLength <= limit) return [{ type: "image", file: image }, { type: "text", text: article.link }]
      return [article.title, article.owner, desc, article.link].filter(Boolean).join("\n")
    },
  }
}
