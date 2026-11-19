import { load } from "cheerio"

const origin = "https://zh.minecraft.wiki"
const license = "https://creativecommons.org/licenses/by-nc-sa/3.0/"
const maxBytes = 512 * 1024
const nonText = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u

export function mcWikiTitle(input) {
  if (typeof input !== "string" || !input.isWellFormed() || nonText.test(input)) return
  const title = input.trim()
  if (!title || title === "." || title === ".." || title.length > 160 ||
      /[|#<>\[\]{}\\]/u.test(title) || /^(?:\/\/|[\w+.-]+:\/\/)/u.test(title)) return
  return title
}

export function mcWikiLink(title) {
  return new URL("/w/" + encodeURIComponent(title.replaceAll(" ", "_")), origin).href
}

function articleLink(value) {
  if (typeof value !== "string") return
  try {
    const url = new URL(value)
    if (url.origin === origin && !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith("/w/")) return url
  } catch {
    return
  }
}

async function request(parameters, transport, signal) {
  signal.throwIfAborted()
  const url = new URL("/api.php", origin)
  url.search = new URLSearchParams({ format: "json", formatversion: "2", ...parameters }).toString()
  const response = await transport(url, {
    method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal,
    headers: { Accept: "application/json", "User-Agent": "Lotus-Yunzai (https://github.com/MOPELotus/Lotus-Yunzai)" },
  })
  if (signal.aborted || response.status !== 200 || response.redirected || (response.url && response.url !== url.href) ||
      !/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "") ||
      Number(response.headers.get("content-length")) > maxBytes) {
    void response.body?.cancel().catch(() => {})
    throw new Error("Minecraft Wiki 响应异常")
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Minecraft Wiki 响应为空")
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  let bytes = 0
  let text = ""
  try {
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw new Error("Minecraft Wiki 响应过长")
      text += decoder.decode(value, { stream: true })
    }
    signal.throwIfAborted()
    return JSON.parse(text + decoder.decode())
  } finally {
    signal.removeEventListener("abort", cancel)
    cancel()
    reader.releaseLock()
  }
}

function compact(value, maximum) {
  const text = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim()
  const points = Array.from(text)
  return points.length <= maximum ? text : points.slice(0, maximum - 1).join("") + "…"
}

function projectLead(html) {
  const $ = load(html, {}, false)
  $("script,style,textarea,iframe,object,embed,video,audio,svg,math,input,button,noscript,template,sup.reference,[hidden],.mw-editsection").remove()
  const content = $(".mw-parser-output").first()
  const paragraphs = content.children("p").toArray().map(node => compact($(node).text(), 360)).filter(Boolean).slice(0, 5)
  const details = []
  for (const node of content.find("table.infobox tr, .infobox table.infobox-rows tr").toArray()) {
    const row = $(node)
    const field = compact(row.children("th").first().text(), 24)
    const edition = compact(row.closest(".tabbertab").attr("data-title") ?? "", 15)
    const label = field && (edition ? `${edition} · ${field}` : field)
    const value = compact(row.children("td").first().text(), 100)
    if (label && value && !details.some(item => item.label === label)) details.push({ label, value })
    if (details.length === 6) break
  }
  return { paragraphs, details }
}

export async function readMcWikiArticle(title, { transport = fetch, signal } = {}) {
  if (mcWikiTitle(title) !== title) throw new TypeError("Minecraft Wiki 条目名称无效")
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(9_000)]) : AbortSignal.timeout(9_000)
  let url = mcWikiLink(title)
  try {
    const result = await request({ action: "query", titles: title, prop: "info", inprop: "url", redirects: "1" }, transport, deadline)
    const pages = result?.query?.pages
    if (!Array.isArray(pages) || pages.length !== 1) return { status: "unavailable", url }
    const [page] = pages
    if (page?.missing === true) return { status: "missing" }
    const canonical = articleLink(page?.fullurl)
    if (!canonical || !Number.isSafeInteger(page?.pageid) || page.pageid <= 0 ||
        !Number.isSafeInteger(page?.lastrevid) || page.lastrevid <= 0 ||
        typeof page.title !== "string" || !page.title || page.contentmodel !== "wikitext") return { status: "unavailable", url }
    url = canonical.href
    const resultAtRevision = await request({
      action: "parse", oldid: String(page.lastrevid), section: "0", prop: "text|revid", variant: "zh-cn",
    }, transport, deadline)
    const lead = resultAtRevision?.parse
    if (lead?.pageid !== page.pageid || lead.revid !== page.lastrevid ||
        lead.title !== page.title || typeof lead.text !== "string") return { status: "unavailable", url }
    const content = projectLead(lead.text)
    if (!content.paragraphs.length && !content.details.length) return { status: "unavailable", url }
    const revision = new URL(url)
    revision.searchParams.set("oldid", String(page.lastrevid))
    return {
      status: "article", url, article: {
        title: compact(page.title, 100), revisionUrl: revision.href, revisionId: page.lastrevid, license, ...content,
      },
    }
  } catch {
    return { status: "unavailable", url }
  }
}
