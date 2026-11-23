import { requestText, DouyinError, type RequestOptions } from "./http.ts"

export const MOBILE_UA = "Mozilla/5.0 (Linux; Android 10; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
const HOSTS = new Set(["douyin.com", "www.douyin.com", "v.douyin.com", "iesdouyin.com", "www.iesdouyin.com"])

const reflowHost = "webcast.amemv.com"
const reflowRoute = /^\/(?:douyin\/)?webcast\/reflow\/([1-9]\d{0,19})\/?$/u

export interface DouyinLiveTarget {
  kind: "live"
  id: string
  url: string
}

export interface DouyinTarget {
  id: string
  type: string
  url: string
}

export function validateDouyinUrl(input: string) {
  let url
  try { url = new URL(input) } catch { throw new DouyinError("invalid_link", "抖音链接格式无效") }
  const allowedHost = HOSTS.has(url.hostname) || url.hostname === reflowHost && reflowRoute.test(url.pathname)
  if (!allowedHost || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new DouyinError("invalid_link", "不支持的抖音链接域名")
  }
  url.protocol = "https:"
  return url
}

export function extractDouyinTarget(message: unknown = "") {
  const raw = String(message).replace(/\\\//g, "/").replace(/&amp;/g, "&")
  const urls = raw.match(/https?:\/\/[^\s<>"'\\{},。！？、；：（）【】《》]+/giu) || []
  for (const input of urls) {
    const candidate = input.replace(/[!?)\].;]+$/u, "")
    try {
      const url = validateDouyinUrl(candidate)
      if (url.hostname === reflowHost || workFromUrl(url) ||
          url.hostname === "v.douyin.com" && url.pathname !== "/") return url.href
    } catch {}
  }
  return ""
}

function workFromUrl(url: URL): DouyinTarget | null {
  if (url.hostname === reflowHost || url.hostname === "v.douyin.com") return null
  const match = url.pathname.match(/^\/(?:share\/)?(video|note|article)\/([1-9]\d{0,19})\/?$/u)
  const keys = ["modal_id", "aweme_id", "item_id", "vid"]
  const queryIds = keys.flatMap(key => url.searchParams.getAll(key))
  const id = match?.[2] ?? (queryIds.length > 0 && queryIds.every(value => value === queryIds[0])
    && /^[1-9]\d{0,19}$/u.test(queryIds[0]!) ? queryIds[0] : undefined)
  return id ? { id, type: match?.[1] || "video", url: url.href } : null
}

export function targetFromUrl(input: string): DouyinTarget | null {
  return workFromUrl(validateDouyinUrl(input))
}

export async function resolveDouyinShare(input: unknown, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000, signal }: RequestOptions = {}):
  Promise<DouyinLiveTarget | { kind: "work"; target: DouyinTarget }> {
  const extracted = extractDouyinTarget(input)
  if (!extracted) throw new DouyinError("invalid_link", "未找到有效的抖音作品链接")
  let url = validateDouyinUrl(extracted)
  for (let hop = 0; hop <= 5; hop++) {
    if (url.hostname === reflowHost) {
      const id = reflowRoute.exec(url.pathname)![1]!
      return { kind: "live", id, url: `https://${reflowHost}${url.pathname.replace(/\/$/u, "")}` }
    }
    const target = targetFromUrl(url.href)
    if (target) return { kind: "work", target }
    const { response } = await requestText(fetchImpl, url.href, { redirect: "manual", credentials: "omit",
      headers: { "User-Agent": MOBILE_UA }, signal }, { timeoutMs, headersOnly: true })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) break
      url = validateDouyinUrl(new URL(location, url).href)
    } else break
  }
  throw new DouyinError("invalid_link", "短链接未跳转到可识别的抖音作品或直播间")
}

export async function resolveDouyinTarget(input: unknown, options: RequestOptions = {}): Promise<DouyinTarget> {
  const share = await resolveDouyinShare(input, options)
  if (share.kind === "live") throw new DouyinError("invalid_link", "抖音直播分享只提供房间预览")
  return share.target
}
