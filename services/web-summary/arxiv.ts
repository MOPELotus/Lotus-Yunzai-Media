import { load } from "cheerio"
import { readOfficialLink, type OfficialLinkFetch } from "../official-links/source.ts"

const paperId = /^((?:\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7}))(v[1-9]\d{0,3})?$/iu

export interface ArxivTarget {
  readonly source: "arxiv"
  readonly id: string
  readonly link: string
}

export function parseArxiv(value: string): ArxivTarget | undefined {
  const url = value.length <= 2048 ? URL.parse(value) : null
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") ||
      !["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(url.hostname) || url.username || url.password || url.port) return
  const path = /^\/(abs|pdf)\/(.+?)\/?$/u.exec(url.pathname)
  if (!path) return
  const id = path[1] === "pdf" ? path[2]!.replace(/\.pdf$/u, "") : path[2]!
  if (paperId.test(id)) return { source: "arxiv", id, link: "https://arxiv.org/abs/" + id }
}

export async function getArxiv(target: ArxivTarget, fetcher: OfficialLinkFetch, signal: AbortSignal) {
  const expected = paperId.exec(target.id)
  if (!expected) return
  const api = new URL("https://export.arxiv.org/api/query")
  api.searchParams.set("id_list", target.id)
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(
    await readOfficialLink(fetcher, api, signal, "application/atom+xml", 256 * 1024))
  if (/<!DOCTYPE|<!ENTITY/iu.test(raw)) return
  const $ = load(raw, { xml: true })
  const entries = $("feed > entry")
  if (entries.length !== 1) return
  const entry = entries.first()
  const actualTarget = parseArxiv(entry.children("id").text().trim())
  if (!actualTarget) return
  const actual = paperId.exec(actualTarget.id)
  if (!actual || actual[1] !== expected[1] || (expected[2] && actual[2] !== expected[2])) return
  const normalize = (value: string) => value.replace(/[\s\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+/gu, " ").trim()
  const title = normalize(entry.children("title").text()).slice(0, 500)
  const owner = entry.children("author").toArray().map(author => normalize($(author).children("name").text()))
    .filter(Boolean).slice(0, 24).join("、").slice(0, 600)
  const text = normalize(entry.children("summary").text()).slice(0, 16_000)
  if (title && owner && text) return { title, owner, text, link: actualTarget.link }
}
