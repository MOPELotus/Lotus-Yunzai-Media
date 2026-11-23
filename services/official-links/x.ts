import { load } from "cheerio"

export interface OfficialXLink { readonly platform: "x"; readonly id: string; readonly link: string }

const hosts = new Set(["x.com", "twitter.com", "www.x.com", "www.twitter.com"])
const statusPath = /^\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d{0,19})(?:\/photo\/[1-9]\d?)?\/?$/u
const accountPath = /^\/([A-Za-z0-9_]{1,15})\/?$/u

export function parseXLink(url: URL, acceptLegacyAlias = false): OfficialXLink | undefined {
  if (!hosts.has(url.hostname) && !(acceptLegacyAlias && url.hostname === "r.com")) return
  const match = statusPath.exec(url.pathname)
  if (match?.[1] && match[2]) return { platform: "x", id: match[2], link: `https://x.com/${match[1]}/status/${match[2]}` }
}

export async function xPreview(input: OfficialXLink, read: (url: URL) => Promise<Buffer>,
  publicUrl: (value: unknown) => URL | undefined, text: (value: unknown, length: number) => string) {
  const endpoint = new URL("https://publish.x.com/oembed")
  endpoint.search = new URLSearchParams({ url: input.link, omit_script: "true", hide_thread: "true", dnt: "true" }).toString()
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read(endpoint)))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
  const data = raw as Record<string, unknown>
  if (data.type !== "rich" || (data.provider_name !== "X" && data.provider_name !== "Twitter") || typeof data.html !== "string") return
  const canonical = publicUrl(data.url)
  const post = canonical?.protocol === "https:" ? parseXLink(canonical) : undefined
  if (post?.id !== input.id) return
  const user = post.link.split("/")[3]!
  const account = publicUrl(data.author_url)
  const handle = account?.protocol === "https:" && hosts.has(account.hostname) ? accountPath.exec(account.pathname)?.[1] : undefined
  if (handle?.toLowerCase() !== user.toLowerCase()) return
  const name = text(data.author_name, 100)
  if (!name) return
  const $ = load(data.html, {}, false)
  const block = $("blockquote.twitter-tweet")
  if (block.length !== 1) return
  const permalinks = block.children("a[href]").filter((_, anchor) => {
    const url = publicUrl($(anchor).attr("href"))
    return url?.protocol === "https:" && parseXLink(url)?.link.toLowerCase() === post.link.toLowerCase()
  })
  const body = block.children("p")
  if (permalinks.length !== 1 || body.length !== 1) return
  body.find("script,style,template,noscript,iframe").remove()
  body.find("br").replaceWith(" ")
  const desc = text(body.text(), 1200)
  if (!desc) return
  return { title: "X 公开帖", owner: `${name} (@${handle})`, desc, link: post.link }
}
