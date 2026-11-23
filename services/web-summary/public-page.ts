import { load } from "cheerio"
import type { OfficialArticle } from "./official-article.ts"
import { createPublicPageNetwork, parsePublicPageUrl } from "./public-page-network.ts"

const maxPageBytes = 1024 * 1024
const maxTextLength = 50_000
const deniedTitle = /^(?:(?:sign|log)[ -]?in(?:\s*[|–—-]|$)|(?:access|permission) denied\b|just a moment\b|attention required\b|verify (?:that )?you are human\b|(?:请)?(?:登录|访问受限|安全验证)(?:$|\s*[|–—-]))/iu
const hidden = "[hidden], [aria-hidden=true], [style*='display:none'], [style*='display: none'], [style*='visibility:hidden'], [style*='visibility: hidden']"

function plain(value: string, max: number) {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().toWellFormed().slice(0, max).toWellFormed()
}

function closedArticle(organization: unknown): boolean {
  if (!organization || typeof organization !== "object") return false
  const record = organization as Record<string, unknown>
  return record.isAccessibleForFree === false || record.isAccessibleForFree === "false" ||
    [record["@graph"], record.hasPart].some(value => Array.isArray(value) ? value.some(item =>
      item?.isAccessibleForFree === false || item?.isAccessibleForFree === "false") :
      value && typeof value === "object" && (value as Record<string, unknown>).isAccessibleForFree === false)
}

export function parsePublicPageHtml(html: string, link: string): OfficialArticle | undefined {
  const $ = load(html)
  const title = plain($("head title").first().text() || $("h1").first().text(), 300)
  if (!title || deniedTitle.test(title) || $(".cf-turnstile, #challenge-form, #cf-challenge-running, [data-paywall=true]").length) return
  if ($("head script[type='application/ld+json']").toArray().some(script => {
    try {
      const json: unknown = JSON.parse($(script).text())
      return Array.isArray(json) ? json.some(closedArticle) : closedArticle(json)
    } catch { return false }
  })) return

  $(`script, style, template, noscript, iframe, svg, nav, aside, footer, [role=navigation], ${hidden}`).remove()
  const articles = $("article, [itemprop=articleBody]")
  const region = articles.length === 1 ? articles : $("main, [role=main]")
  const content = region.length === 1 ? region : $("body")
  if (content.find("input[type=password], form[action*='paywall']").length) return
  const paragraphs: string[] = []
  let remaining = maxTextLength
  for (const block of content.find("p,h1,h2,h3,h4,h5,h6,li,blockquote,pre").toArray()) {
    if (remaining <= 0) break
    if ($(block).children("p,ul,ol,blockquote,pre").length) continue
    const text = plain($(block).text(), remaining)
    if (!text || text === title) continue
    paragraphs.push(text)
    remaining -= text.length + 1
  }
  const text = paragraphs.join("\n")
  if (text.length < 32 || deniedTitle.test(text)) return
  const owner = plain($("head meta[name=author]").first().attr("content") ?? "", 100)
  return { title, text, link, ...(owner && { owner }) }
}

async function readHtml(response: Response, signal: AbortSignal) {
  const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (response.status !== 200 || mime !== "text/html" || !response.body ||
      response.headers.get("content-range") || Number(response.headers.get("content-length")) > maxPageBytes) {
    await response.body?.cancel().catch(() => undefined)
    return
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body) {
    signal.throwIfAborted()
    total += chunk.length
    if (total > maxPageBytes) return
    chunks.push(chunk)
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))
}

export function createPublicPageReader(network = createPublicPageNetwork()) {
  return async function read(input: string, signal: AbortSignal, modelUrl?: string) {
    const url = parsePublicPageUrl(input)
    if (!url) return
    const result = await network(url, signal, modelUrl)
    if (!result) return
    const html = await readHtml(result, signal)
    if (html) return parsePublicPageHtml(html, input)
  }
}
