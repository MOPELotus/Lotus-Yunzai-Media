import { requestText, DouyinError, type RequestOptions } from "./http.ts"
import { MOBILE_UA, targetFromUrl, validateDouyinUrl } from "./links.ts"
import type { AwemeDetail } from "./model.ts"

interface RouterData {
  loaderData?: Record<string, { videoInfoRes?: { item_list?: AwemeDetail[]; status_msg?: string } }>
}

/** Balanced JSON scan: braces inside escaped strings do not terminate the object. */
export function extractRouterData(html: string): RouterData {
  const assignment = /window\s*\.\s*_ROUTER_DATA\s*=\s*/g
  let match
  while ((match = assignment.exec(html))) {
    const start = match.index + match[0].length
    if (html[start] !== "{") continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < html.length; index++) {
      const char = html[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === "{") depth++
      else if (char === "}" && --depth === 0) {
        try { return JSON.parse(html.slice(start, index + 1)) as RouterData } catch { break }
      }
    }
  }
  throw new DouyinError("ssr_structure", "分享页面未找到有效的 _ROUTER_DATA")
}

export function detailFromRouter(router: RouterData, id: string) {
  for (const value of Object.values(router?.loaderData || {})) {
    const result = value?.videoInfoRes
    const detail = result?.item_list?.find(item => String(item?.aweme_id || "") === id)
    if (detail) return detail
    const message = String(result?.status_msg || "")
    if (/已删除|不存在|私密|无权|不可见/.test(message)) throw new DouyinError("unavailable", message)
  }
  throw new DouyinError("ssr_empty", "分享页面没有可用的作品详情")
}

export async function fetchSsrDetail(id: string, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000, signal }: RequestOptions = {}) {
  if (!/^[1-9]\d{0,19}$/u.test(id)) throw new DouyinError("invalid_link", "抖音作品 ID 无效")
  const active = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  let url = new URL(`https://www.iesdouyin.com/share/video/${id}/`)
  for (let hop = 0; hop <= 3; hop++) {
    const { response, text } = await requestText(fetchImpl, url.href, {
      redirect: "manual", credentials: "omit", signal: active,
      headers: { "User-Agent": MOBILE_UA, Referer: "https://www.douyin.com/" },
    }, { timeoutMs })
    if (response.ok) return detailFromRouter(extractRouterData(text), id)
    const location = response.status >= 300 && response.status < 400 && response.headers.get("location")
    if (!location) throw new DouyinError("ssr_http", `分享页面 HTTP ${response.status}`)
    const next = validateDouyinUrl(new URL(location, url).href)
    if (targetFromUrl(next.href)?.id !== id) throw new DouyinError("ssr_redirect", "分享页面跳转到其他作品")
    url = next
  }
  throw new DouyinError("ssr_redirect", "分享页面跳转次数超出限制")
}
