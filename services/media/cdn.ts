const douyinDomains = ["douyin.com", "iesdouyin.com", "douyinpic.com", "douyincdn.com", "douyinvod.com", "byteimg.com", "bytefcdn.com", "bytedance.com", "bytecdn.cn", "ixigua.com"]
const imageDomains = [...douyinDomains, "hdslb.com", "bilibili.com", "biliimg.com"]

function mediaUrl(value: string | URL, domains: readonly string[]) {
  const url = new URL(value)
  if (!["https:", "http:"].includes(url.protocol) || url.port || url.username || url.password ||
      !domains.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain))) {
    throw new Error("媒体地址不属于平台 CDN。")
  }
  url.protocol = "https:"
  return url
}

export type MediaFetch = (url: string, options?: RequestInit) => Promise<Response>

export async function fetchCdn(fetchImpl: MediaFetch, value: string | URL, options: RequestInit, kind?: "image") {
  const domains = kind === "image" ? imageDomains : douyinDomains
  let url = mediaUrl(value, domains)
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetchImpl(url.href, { ...options, redirect: "manual" })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    await response.body?.cancel()
    const location = response.headers.get("location")
    if (!location) break
    url = mediaUrl(new URL(location, url), domains)
  }
  throw new Error("媒体地址重定向无效。")
}
