const douyinDomains = ["douyin.com", "iesdouyin.com", "douyinpic.com", "douyincdn.com", "douyinvod.com", "byteimg.com", "bytefcdn.com", "bytedance.com", "bytecdn.cn", "ixigua.com"]
const imageDomains = [...douyinDomains, "hdslb.com", "bilibili.com", "biliimg.com", "upload-bbs.miyoushe.com", "upload-bbs.mihoyo.com"]
const miyousheVideoDomains = new Set(["prod-vod-sign.miyoushe.com", "prod-vod-sign.mihoyo.com"])
const acfunVideoHosts = new Set(["tx-safety-video.acfun.cn", "ali-safety-video.acfun.cn"])
const acfunImageHosts = new Set(["tx-free-imgs.acfun.cn"])
export type CdnKind = "image" | "miyoushe-video" | "netease-mv" | "acfun-image" | "acfun-video" | "pipixia-video"

function acfunCdnUrl(value: string | URL, hosts: ReadonlySet<string>) {
  const url = URL.parse(String(value))
  if (url?.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash && hosts.has(url.hostname)) return url
}

export function acfunVideoUrl(value: string | URL) {
  return acfunCdnUrl(value, acfunVideoHosts)
}

export function acfunImageUrl(value: string | URL) {
  return acfunCdnUrl(value, acfunImageHosts)
}

export function isMiyousheVideoUrl(url: URL) {
  return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash && miyousheVideoDomains.has(url.hostname)
}

export function isPipixiaVideoUrl(url: URL) {
  return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash &&
    /^v\d+-cdn-tos\.ppxvod\.com$/u.test(url.hostname)
}

export function neteaseMvUrl(value: string | URL) {
  const url = URL.parse(String(value))
  if (url && (url.protocol === "https:" || url.protocol === "http:") && !url.port && !url.username && !url.password &&
      !url.hash && url.hostname.endsWith(".vod.126.net")) {
    url.protocol = "https:"
    return url
  }
}

function mediaUrl(value: string | URL, domains: readonly string[]) {
  const url = new URL(value)
  if (!["https:", "http:"].includes(url.protocol) || url.port || url.username || url.password ||
      !domains.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain))) {
    throw new Error("媒体地址不属于平台 CDN。")
  }
  url.protocol = "https:"
  return url
}

interface MediaRequest {
  readonly headers?: Record<string, string>
  readonly credentials?: RequestCredentials
  readonly redirect?: RequestRedirect
  readonly signal?: AbortSignal
}

export type MediaFetch = (url: string, options?: MediaRequest) => Promise<Response>

export async function fetchCdn(fetchImpl: MediaFetch, value: string | URL, options: MediaRequest, kind?: CdnKind) {
  const domains = kind === "image" ? imageDomains : douyinDomains
  function target(value: string | URL) {
    if (kind === "acfun-video" || kind === "acfun-image") {
      const url = kind === "acfun-video" ? acfunVideoUrl(value) : acfunImageUrl(value)
      if (!url || kind === "acfun-video" && !/\.(?:m3u8|ts)$/u.test(url.pathname)) throw new Error("媒体地址不属于 AcFun CDN。")
      return url
    }
    if (kind === "netease-mv") {
      const url = neteaseMvUrl(value)
      if (!url) throw new Error("媒体地址不属于网易云 MV CDN。")
      return url
    }
    if (kind === "pipixia-video") {
      const url = new URL(value)
      if (!isPipixiaVideoUrl(url)) throw new Error("媒体地址不属于皮皮虾视频 CDN。")
      return url
    }
    if (kind !== "miyoushe-video") return mediaUrl(value, domains)
    const url = new URL(value)
    if (!isMiyousheVideoUrl(url)) throw new Error("媒体地址不属于米游社视频 CDN。")
    return url
  }
  let url = target(value)
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetchImpl(url.href, { ...options,
      ...((kind === "miyoushe-video" || kind === "netease-mv" || kind === "acfun-video" || kind === "acfun-image" || kind === "pipixia-video") && { credentials: "omit" as const }), redirect: "manual" })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    await response.body?.cancel()
    const location = response.headers.get("location")
    if (!location) break
    url = target(new URL(location, url))
  }
  throw new Error("媒体地址重定向无效。")
}
