import type { MediaFetch } from "../media/cdn.ts"

const redirectStatuses = new Set([301, 302, 303, 307, 308])
const desktopAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"

export async function readPublicSharePage(start: URL, accept: (url: URL) => boolean, fetch: MediaFetch, signal: AbortSignal, headers: Readonly<Record<string, string>> = {
  "User-Agent": desktopAgent, Accept: "text/html,application/xhtml+xml",
}) {
  const maxBytes = 2_000_000
  let url = start
  for (let hop = 0; hop <= 5 && accept(url); hop++) {
    const response = await fetch(url.href, { credentials: "omit", redirect: "manual", signal, headers })
    if (redirectStatuses.has(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get("location")
      const next = location ? URL.parse(location, url) : undefined
      if (!next) return
      url = next
      continue
    }
    if (!response.ok || response.redirected || !response.body || Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel()
      return
    }
    const chunks = []
    let size = 0
    for await (const part of response.body) {
      size += part.byteLength
      if (size > maxBytes) return
      chunks.push(part)
    }
    return { url, html: Buffer.concat(chunks, size).toString("utf8") }
  }
}
