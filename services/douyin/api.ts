import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { WEB_UA, generateABogus } from "./signature.ts"
import { requestText, DouyinError, type RequestOptions } from "./http.ts"
import { signVisitorUrl } from "./guest-signature.ts"
import { douyinWorkId, type AwemeDetail } from "./model.ts"
import type { VisitorSession } from "./visitor.ts"

export type DetailSigner = (query: string, options: { userAgent: string; now: number }) => string

interface DetailOptions {
  sign?: DetailSigner
  now?: number
}

interface DetailResponse {
  status_msg?: string
  message?: string
  status_code?: number
  aweme_detail?: AwemeDetail
}

export function buildDetailUrl(id: string, { sign = generateABogus, now = Date.now() }: DetailOptions = {}) {
  const params = new URLSearchParams({
    device_platform: "webapp", aid: "6383", channel: "channel_pc_web", aweme_id: id,
    pc_client_type: "1", version_code: "190500", version_name: "19.5.0", cookie_enabled: "true",
    screen_width: "1920", screen_height: "1080", browser_language: "zh-CN", browser_platform: "Win32",
    browser_name: "Chrome", browser_version: "146.0.0.0", browser_online: "true", engine_name: "Blink",
    engine_version: "146.0.0.0", os_name: "Windows", os_version: "10", cpu_core_num: "8", device_memory: "8", platform: "PC",
    timestamp: String(Math.floor(now / 1000)),
  })
  const query = params.toString()
  return `https://www.douyin.com/aweme/v1/web/aweme/detail/?${query}&a_bogus=${encodeURIComponent(sign(query, { userAgent: WEB_UA, now }))}`
}

export async function fetchWebDetail(id: string, visitor: string | VisitorSession, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000, signal, sign, now = Date.now() }: RequestOptions & DetailOptions = {}) {
  const session = typeof visitor === "string" ? { ttwid: visitor, uifid: undefined } : visitor
  const detailUrl = buildDetailUrl(id, { sign, now })
  const request = session?.uifid ? signVisitorUrl(detailUrl, session.uifid, { now }) : { url: detailUrl, headers: {} }
  const { response, text } = await requestText(fetchImpl, request.url, {
    redirect: "error", signal, headers: { "User-Agent": WEB_UA, Referer: "https://www.douyin.com/", "Accept-Language": "zh-CN,zh;q=0.9", Cookie: `ttwid=${session?.ttwid || ""};`, ...request.headers },
  }, { timeoutMs })
  if (!response.ok) {
    if (/ArgusSecurityPlugin|Uifid Not Found/i.test(text)) throw new DouyinError("risk_control", $t("services.douyin.api.text_22b95e5136"))
    throw new DouyinError("api_http", $t("services.douyin.api.text_2555b3220b", { "status": response.status }))
  }
  let payload: unknown
  try { payload = JSON.parse(text) } catch {}
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DouyinError("api_empty", $t("services.douyin.api.text_685f5bdd1d"))
  }
  const data = payload as DetailResponse
  const message = typeof data.status_msg === "string" ? data.status_msg : typeof data.message === "string" ? data.message : ""
  if (data.status_code !== 0) {
    if (/已删除|不存在|私密|无权|不可见/.test(message)) throw new DouyinError("unavailable", message)
    throw new DouyinError("api_rejected", $t("services.douyin.api.text_ceb74efb24"))
  }
  if (!data.aweme_detail || douyinWorkId(data.aweme_detail.aweme_id) !== id) throw new DouyinError("api_empty", $t("services.douyin.api.text_518c8ed925"))
  return data.aweme_detail
}
