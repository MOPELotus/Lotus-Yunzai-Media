import { createHash } from "node:crypto"
import { load } from "cheerio"

interface GitHubReadme {
  readonly source: "github"
  readonly owner: string
  readonly repo: string
  readonly link: string
  readonly file?: { readonly ref: string; readonly path: string }
}

interface NewsArticle {
  readonly source: "sspai" | "chinadaily"
  readonly link: string
}

export type OfficialArticleTarget = GitHubReadme | NewsArticle
export type OfficialArticleFetch = (url: URL, options: RequestInit) => Promise<Response>
export interface OfficialArticle {
  readonly title: string
  readonly owner?: string
  readonly text: string
  readonly link: string
}

const githubHost = "github.com"
const githubApi = "api.github.com"
const sspaiHost = "sspai.com"
const chinaDailyHost = "global.chinadaily.com.cn"
const githubOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u
const githubRepo = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/u
const githubRef = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u
const readmeName = /^readme(?:\.(?:md|markdown|txt|rst|adoc|asciidoc))?$/iu
const sspaiPath = /^\/post\/[1-9][0-9]{0,9}$/u
const chinaDailyPath = /^\/a\/[12]\d{3}(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/WS[0-9a-f]{24}\.html$/u
const maxReadmeBytes = 256 * 1024
const maxText = 50_000
const utf8 = new TextDecoder("utf-8", { fatal: true })

function articleUrl(value: unknown, base?: string) {
  const url = typeof value === "string" && value.length <= 2048 ? URL.parse(value, base) : undefined
  if (url && (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.port) return url
}

export function parseOfficialArticle(value: string): OfficialArticleTarget | undefined {
  const url = articleUrl(value)
  if (!url) return
  const path = url.pathname.replace(/\/$/u, "")
  if (url.hostname === sspaiHost && sspaiPath.test(path)) return { source: "sspai", link: `https://${sspaiHost}${path}` }
  if (url.hostname === chinaDailyHost && chinaDailyPath.test(path)) return { source: "chinadaily", link: `https://${chinaDailyHost}${path}` }
  if (url.hostname !== githubHost) return
  const [, owner, repo, action, ref, filename, ...rest] = path.split("/")
  if (!owner || !repo || !githubOwner.test(owner) || !githubRepo.test(repo) || rest.length) return
  const root = `https://${githubHost}/${owner}/${repo}`
  if (action === undefined) return { source: "github", owner, repo, link: root }
  if (action !== "blob" || !ref || !githubRef.test(ref) || !filename || !readmeName.test(filename)) return
  return { source: "github", owner, repo, file: { ref, path: filename }, link: `${root}/blob/${ref}/${filename}` }
}

async function bounded(fetcher: OfficialArticleFetch, url: URL, signal: AbortSignal, accept: string, mime: readonly string[], limit: number) {
  const response = await fetcher(url, { signal, credentials: "omit", redirect: "error",
    headers: { Accept: accept, "User-Agent": "Lotus-Yunzai" } })
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (!response.ok || response.redirected || !type || !mime.includes(type) ||
      Number(response.headers.get("content-length")) > limit || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    return
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const piece of response.body) {
    signal.throwIfAborted()
    size += piece.byteLength
    if (size > limit) return
    chunks.push(piece)
  }
  return utf8.decode(Buffer.concat(chunks, size))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function safeText(value: string) {
  return value.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ")
}

function truncate(value: string, max: number) {
  return Array.from(value.trim()).slice(0, max).join("")
}

function clean(value: unknown, max: number) {
  if (typeof value !== "string") return ""
  return truncate(safeText(value).replace(/[^\S\n]+/gu, " ").replace(/ *\n */gu, "\n").replace(/\n{3,}/gu, "\n\n"), max)
}

async function github(target: GitHubReadme, fetcher: OfficialArticleFetch, signal: AbortSignal): Promise<OfficialArticle | undefined> {
  const repo = `/repos/${target.owner}/${target.repo}`
  const endpoint = new URL(`https://${githubApi}${repo}${target.file ? "/contents/" + target.file.path : "/readme"}`)
  if (target.file) endpoint.searchParams.set("ref", target.file.ref)
  const json = await bounded(fetcher, endpoint, signal, "application/vnd.github+json",
    ["application/json", "application/vnd.github+json"], 384 * 1024)
  const data = json && record(JSON.parse(json))
  if (!data || data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string" ||
      typeof data.path !== "string" || typeof data.size !== "number" || !Number.isSafeInteger(data.size) ||
      data.size < 1 || data.size > maxReadmeBytes || typeof data.sha !== "string") return
  const segments = data.path.split("/")
  const name = segments.at(-1)
  if (!name || name !== data.name || !readmeName.test(name) ||
      (segments.length !== 1 && !(segments.length === 2 && [".github", "docs"].includes(segments[0]!)))) return
  const api = articleUrl(data.url)
  const html = articleUrl(data.html_url)
  if (api?.protocol !== "https:" || api.hostname !== githubApi || html?.protocol !== "https:" || html.hostname !== githubHost ||
      api.pathname.toLowerCase() !== `${repo}/contents/${data.path}`.toLowerCase()) return
  const ref = api.searchParams.get("ref")
  if (!ref || api.searchParams.getAll("ref").length !== 1 ||
      !githubRef.test(ref) || !html.pathname.toLowerCase().startsWith(`/${target.owner}/${target.repo}/blob/`.toLowerCase()) ||
      html.pathname.split("/").slice(4).join("/") !== `${ref}/${data.path}` ||
      (target.file && (ref !== target.file.ref || data.path !== target.file.path))) return
  const base64 = data.content.replace(/[\r\n]/gu, "")
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) return
  const bytes = Buffer.from(base64, "base64")
  if (bytes.length !== data.size || bytes.toString("base64") !== base64 ||
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== data.sha) return
  const text = truncate(safeText(utf8.decode(bytes)), maxText)
  if (text) return { title: `${target.owner}/${target.repo} · ${data.path}`, owner: target.owner, text, link: target.link }
}

async function article(target: NewsArticle, fetcher: OfficialArticleFetch, signal: AbortSignal): Promise<OfficialArticle | undefined> {
  const html = await bounded(fetcher, new URL(target.link), signal, "text/html", ["text/html"], 1024 * 1024)
  if (!html) return
  const $ = load(html)
  const ogUrl = $('head meta[property="og:url"]')
  const canonical = articleUrl(ogUrl.attr("content"), target.link)
  if (ogUrl.length !== 1 || !canonical || parseOfficialArticle(canonical.href)?.link !== target.link) return
  const sspai = target.source === "sspai"
  const titleTag = $(sspai ? "article #article-title" : ".content-left h1")
  const body = $(sspai ? "article .article__main__content" : ".content-left #Content")
  if (titleTag.length !== 1 || body.length !== 1) return
  const title = clean(titleTag.text(), 300)
  const schemaType = sspai ? "Article" : "NewsArticle"
  let owner = ""
  for (const script of $('head script[type="application/ld+json"]').toArray()) {
    try {
      const schema = record(JSON.parse($(script).text()))
      if (!schema || schema["@type"] !== schemaType) continue
      const schemaUrl = schema.url ?? record(schema.mainEntityOfPage)?.["@id"]
      if (schemaUrl !== undefined) {
        const item = articleUrl(schemaUrl, target.link)
        if (!item || parseOfficialArticle(item.href)?.link !== target.link) continue
      }
      owner = clean(record(schema.author)?.name, 100)
      if (owner) break
    } catch { continue }
  }
  body.find("script,style,template,noscript,iframe,svg,form,[hidden],[aria-hidden=true]").remove()
  body.find("br").replaceWith("\n")
  for (const block of body.find("p,h2,h3,h4,h5,h6,li,pre,blockquote").toArray()) $(block).after("\n")
  const text = clean(body.text(), maxText)
  if (title && text) return { title, ...(owner && { owner }), text, link: target.link }
}

export async function getOfficialArticle(target: OfficialArticleTarget, fetcher: OfficialArticleFetch, signal: AbortSignal): Promise<OfficialArticle | undefined> {
  const parsed = parseOfficialArticle(target.link)
  if (!parsed || parsed.source !== target.source) return
  signal.throwIfAborted()
  return parsed.source === "github" ? github(parsed, fetcher, signal) : article(parsed, fetcher, signal)
}
