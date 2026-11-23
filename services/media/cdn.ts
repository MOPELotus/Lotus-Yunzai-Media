const douyinDomains = ["douyin.com", "iesdouyin.com", "douyinpic.com", "douyincdn.com", "douyinvod.com", "byteimg.com", "bytefcdn.com", "bytedance.com", "bytecdn.cn", "ixigua.com"]
const imageDomains = [...douyinDomains, "hdslb.com", "bilibili.com", "biliimg.com", "upload-bbs.miyoushe.com", "upload-bbs.mihoyo.com",
  "pic.weishi.qq.com", "xp.qpic.cn", "web-f01.izuiyou.com"]
const miyousheVideoDomains = new Set(["prod-vod-sign.miyoushe.com", "prod-vod-sign.mihoyo.com"])
const acfunVideoHosts = new Set(["tx-safety-video.acfun.cn", "ali-safety-video.acfun.cn"])
const acfunImageHosts = new Set(["tx-free-imgs.acfun.cn"])
export type MusicVideoCdn = "netease-mv" | "kuwo-mv" | "qq-mv" | "kugou-mv"
export type CdnKind = "image" | "miyoushe-video" | MusicVideoCdn | "acfun-image" | "acfun-video" | "weishi-video" | "zuiyou-video" | "pipixia-video" | "kuaishou-video"

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

const publicVideoHosts = { "weishi-video": "v.weishi.qq.com", "zuiyou-video": "web-v01.izuiyou.com" }

export function publicShareVideoUrl(value: string | URL, kind: keyof typeof publicVideoHosts) {
  const url = URL.parse(String(value))
  if (!url || !["https:", "http:"].includes(url.protocol) || url.hostname !== publicVideoHosts[kind] ||
      url.port || url.username || url.password || url.hash) return
  url.protocol = "https:"
  return url
}

export function isMiyousheVideoUrl(url: URL) {
  return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash && miyousheVideoDomains.has(url.hostname)
}

export function kuaishouCoverUrl(value: string | URL) {
  const url = URL.parse(String(value))
  if (url?.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash &&
      /^p\d+\.a\.(?:yximgs|kwimgs)\.com$/u.test(url.hostname)) return url
}

export function kuaishouVideoUrl(value: string | URL) {
  const url = URL.parse(String(value))
  if (url?.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash &&
      /^(?:[a-z]{2}mov\d+\.a\.kwimgs\.com|v\d+(?:-\d+)?\.kwaicdn\.com)$/u.test(url.hostname) &&
      /\.mp4$/u.test(url.pathname)) return url
}

export function jikeImageUrl(value: string | URL) {
  const url = URL.parse(String(value))
  if (url?.origin === "https://cdnv2.ruguoapp.com" && !url.username && !url.password && !url.hash) return url
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

export function musicVideoCdnUrl(value: string | URL, kind: MusicVideoCdn) {
  if (kind === "netease-mv") return neteaseMvUrl(value)
  const url = URL.parse(String(value))
  if (!url || !["https:", "http:"].includes(url.protocol) || url.port || url.username || url.password || url.hash ||
      !/\.mp4$/iu.test(url.pathname)) return
  if (kind === "qq-mv" && url.hostname.endsWith(".stream.tencentmusic.com") ||
      kind === "kuwo-mv" && /^kw-[a-z0-9-]+\.kuwo\.cn$/u.test(url.hostname) ||
      kind === "kugou-mv" && url.hostname === "mvwebfs.tx.kugou.com") {
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
    if (kind === "netease-mv" || kind === "kuwo-mv" || kind === "qq-mv" || kind === "kugou-mv") {
      const url = musicVideoCdnUrl(value, kind)
      if (!url) {
        const platform = kind === "netease-mv" ? "网易云" : kind === "kuwo-mv" ? "酷我" : kind === "kugou-mv" ? "酷狗" : "QQ 音乐"
        throw new Error(`媒体地址不属于${platform} MV CDN。`)
      }
      return url
    }
    if (kind === "image") {
      const cover = kuaishouCoverUrl(value) ?? jikeImageUrl(value)
      if (cover) return cover
    }
    if (kind === "kuaishou-video") {
      const url = kuaishouVideoUrl(value)
      if (!url) throw new Error("媒体地址不属于快手视频 CDN。")
      return url
    }
    if (kind === "pipixia-video") {
      const url = new URL(value)
      if (!isPipixiaVideoUrl(url)) throw new Error("媒体地址不属于皮皮虾视频 CDN。")
      return url
    }
    if (kind === "weishi-video" || kind === "zuiyou-video") {
      const url = publicShareVideoUrl(value, kind)
      if (!url) throw new Error("视频地址不属于分享来源的 CDN。")
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
      ...(kind && { credentials: "omit" as const }), redirect: "manual" })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    await response.body?.cancel()
    const location = response.headers.get("location")
    if (!location) break
    url = target(new URL(location, url))
  }
  throw new Error("媒体地址重定向无效。")
}
