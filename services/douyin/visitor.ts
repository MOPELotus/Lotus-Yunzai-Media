import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { requestText, DouyinError, type DouyinFetch, type RequestOptions } from "./http.ts"
import { WEB_UA } from "./signature.ts"
import { generateNonceSignature } from "./guest-signature.ts"

export interface VisitorSession {
  ttwid: string
  uifid: string
}

export interface VisitorRequest {
  refresh?: boolean
  previous?: string | VisitorSession
  timeoutMs?: number
}

interface VisitorIdentity {
  value: string
  expires: number
  session?: VisitorSession
  sessionExpires?: number
}

const guestCookies = (response: Response) => {
  const headers = response.headers.getSetCookie?.() || [response.headers.get("set-cookie") || ""]
  const cookies: Record<string, string> = {}
  for (const name of ["ttwid", "__ac_nonce", "UIFID_TEMP", "UIFID"]) {
    const value = headers.map(header => header.match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,\\s]+)`))?.[1]).find(Boolean)
    if (value) cookies[name] = value
  }
  return cookies
}

// A visitor identity only. Work responses and download files are never cached.
export class DouyinVisitor {
  readonly fetch: DouyinFetch
  readonly now: () => number
  readonly timeoutMs: number
  private identity: VisitorIdentity | null = null
  private pending: Promise<string> | null = null
  private sessionPending: { value: string; promise: Promise<VisitorSession> } | null = null

  constructor({ fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 }: RequestOptions & { now?: () => number } = {}) {
    this.fetch = fetchImpl
    this.now = now
    this.timeoutMs = timeoutMs
  }

  /** Bootstrap an anonymous web visitor; no browser or user-supplied Cookie. */
  async getSession({ refresh = false, previous = "", timeoutMs = this.timeoutMs }: VisitorRequest = {}) {
    const deadline = Date.now() + timeoutMs
    const remaining = () => {
      const budget = deadline - Date.now()
      if (budget <= 0) throw new DouyinError("timeout", $t("services.douyin.visitor.text_02b77b9098"))
      return budget
    }
    const value = await this.get({ refresh, previous: typeof previous === "object" ? previous.ttwid : previous, timeoutMs: remaining() })
    const identity = this.identity!
    if (identity.session && identity.sessionExpires! > this.now()) return identity.session
    if (this.sessionPending?.value === value) return this.sessionPending.promise
    const pending = { value, promise: this.bootstrap(value, remaining).then(session => {
      if (this.identity === identity) {
        identity.value = session.ttwid
        identity.session = session
        identity.sessionExpires = Math.min(identity.expires, this.now() + 30 * 60 * 1000)
      }
      return session
    }) }
    this.sessionPending = pending
    try { return await pending.promise } finally { if (this.sessionPending === pending) this.sessionPending = null }
  }

  async bootstrap(ttwid: string, remaining: () => number): Promise<VisitorSession> {
    const url = "https://www.douyin.com/"
    const cookies: Record<string, string> & { ttwid: string } = { ttwid }
    const request = async () => {
      const { response } = await requestText(this.fetch, url, {
        redirect: "error", headers: { "User-Agent": WEB_UA, Cookie: Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ") },
      }, { timeoutMs: remaining(), headersOnly: true })
      if (!response.ok) throw new DouyinError("visitor", $t("services.douyin.visitor.text_63bebb4a59", { "status": response.status }))
      Object.assign(cookies, guestCookies(response))
    }
    await request()
    if (!cookies.UIFID && !cookies.UIFID_TEMP) {
      if (!cookies.__ac_nonce) throw new DouyinError("visitor", $t("services.douyin.visitor.text_9110b0a674"))
      cookies.__ac_signature = generateNonceSignature(cookies.__ac_nonce, { url, now: this.now() })
      cookies.__ac_referer = "__ac_blank"
      await request()
    }
    const uifid = cookies.UIFID || cookies.UIFID_TEMP
    if (!uifid) throw new DouyinError("visitor", $t("services.douyin.visitor.text_d16a96b59b"))
    return { ttwid: cookies.ttwid, uifid }
  }

  async get({ refresh = false, previous = "", timeoutMs = this.timeoutMs }: VisitorRequest = {}) {
    if (refresh && this.identity?.value === previous) this.identity = null
    if (this.identity && this.identity.expires > this.now()) return this.identity.value
    if (this.pending) return this.pending
    this.pending = this.register(timeoutMs)
    try { return await this.pending } finally { this.pending = null }
  }

  async register(timeoutMs = this.timeoutMs) {
    const { response } = await requestText(this.fetch, "https://ttwid.bytedance.com/ttwid/union/register/", {
      method: "POST", redirect: "manual", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: "cn", aid: 1768, needFid: false, service: "www.ixigua.com", migrate_info: { ticket: "", source: "node" }, cbUrlProtocol: "https", union: true }),
    }, { timeoutMs })
    if (!response.ok) throw new DouyinError("visitor", $t("services.douyin.visitor.text_254a09fad3", { "status": response.status }))
    const cookies = response.headers.getSetCookie?.() || [response.headers.get("set-cookie") || ""]
    const cookie = cookies.find(value => /(?:^|[;,]\s*)ttwid=/.test(value)) || ""
    const value = cookie.match(/(?:^|[;,]\s*)ttwid=([^;]+)/)?.[1]
    if (!value) throw new DouyinError("visitor", $t("services.douyin.visitor.text_97ff6221df"))
    const seconds = Number(cookie.match(/max-age=(\d+)/i)?.[1] || 86400)
    this.identity = { value, expires: this.now() + Math.min(seconds, 86400) * 1000 }
    return value
  }
}

let defaultVisitor: DouyinVisitor | undefined
export function getDefaultVisitor() {
  return defaultVisitor ||= new DouyinVisitor()
}
