// Anonymous visitor recovery adapted from snowtafir/yuki-plugin@efe622d7578edcaacbfe3b3edfa69ad21445726c (MIT).
// Visitor credentials remain isolated from stored account sessions.
type Transport = (url: URL, options?: RequestInit) => Promise<Response>
const origin = "https://visitor.passport.weibo.cn"
const visitorNames = new Set(["SUB", "SUBP", "_T_WM", "M_WEIBOCN_PARAMS", "WEIBOCN_FROM", "tid"])

function visitorCookie(headers: Headers) {
  const cookies = new Map<string, string>()
  for (const raw of headers.getSetCookie()) {
    const [pair, ...attributes] = raw.split(";")
    const split = pair!.indexOf("=")
    const name = pair!.slice(0, split).trim(), value = pair!.slice(split + 1).trim()
    if (split < 1 || !visitorNames.has(name) || !value || /^deleted$/iu.test(value) || /[^\x21-\x2b\x2d-\x3a\x3c-\x7e]/u.test(value)) continue
    const attrs = new Map(attributes.map(part => {
      const split = part.indexOf("=")
      return [part.slice(0, split < 0 ? undefined : split).trim().toLowerCase(), split < 0 ? "" : part.slice(split + 1).trim()]
    }))
    const domain = attrs.get("domain")?.toLowerCase().replace(/^\./u, "")
    if (domain && domain !== "weibo.cn" && domain !== "visitor.passport.weibo.cn") continue
    const age = attrs.get("max-age"), expires = attrs.get("expires")
    if (age !== undefined ? !/^\d+$/u.test(age) || Number(age) <= 0 : expires && !(Date.parse(expires) > Date.now())) continue
    const path = attrs.get("path")
    if (path && path !== "/" && path !== "/visitor" && path !== "/visitor/visitor") continue
    cookies.set(name, value)
  }
  return cookies.has("SUB") ? [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") : undefined
}

export function withWeiboVisitorRecovery(request: Transport): Transport {
  let cached: { cookie: string; expires: number } | undefined
  let pending: Promise<string | undefined> | undefined
  let retryAt = 0
  async function bootstrap() {
    const signal = AbortSignal.timeout(8000)
    const headers = { "User-Agent": "Mozilla/5.0", Referer: origin + "/", Origin: origin }
    const response = await request(new URL("/visitor/genvisitor", origin), {
      method: "POST", signal, redirect: "error", credentials: "omit",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: new URLSearchParams({ cb: "gen_callback", fp: JSON.stringify({ os: "1", browser: "Chrome142,0,0,0", fonts: "undefined",
        screenInfo: "1920*1080*24", plugins: "Portable Document Format::internal-pdf-viewer::Chromium PDF Viewer::WebKit built-in PDF" }) }).toString(),
    })
    if (!response.ok) { await response.body?.cancel(); return }
    const raw = await response.text()
    if (raw.length > 32768) return
    const match = /^\s*(?:window\.gen_callback\s*&&\s*)?gen_callback\s*\(([\s\S]*)\)\s*;?\s*$/u.exec(raw)
    if (!match) return
    const payload = JSON.parse(match[1]!) as { retcode?: unknown; data?: { tid?: unknown } }
    const tid = payload.data?.tid
    if (payload.retcode !== 20000000 || typeof tid !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(tid)) return
    const url = new URL("/visitor/visitor", origin)
    url.search = new URLSearchParams({ a: "incarnate", t: tid, w: "2", c: "095", gc: "", cb: "cross_domain", from: "weibo", _rand: Math.random().toString().slice(2, 12) }).toString()
    const entered = await request(url, { method: "GET", headers, signal, credentials: "omit", redirect: "manual" })
    const cookie = (entered.ok || entered.status === 302) ? visitorCookie(entered.headers) : undefined
    await entered.body?.cancel()
    if (cookie) cached = { cookie, expires: Date.now() + 30 * 60_000 }
    return cookie
  }
  return async (url, options = {}) => {
    const headers = new Headers(options.headers)
    if (url.origin !== "https://m.weibo.cn" || url.pathname !== "/api/container/getIndex" || headers.has("Cookie")) return request(url, options)
    if (cached && cached.expires > Date.now()) headers.set("Cookie", cached.cookie)
    const response = await request(url, { ...options, headers })
    if (response.status !== 432) return response
    if (cached && cached.expires > Date.now() && cached.cookie !== headers.get("Cookie")) {
      await response.body?.cancel()
      options.signal?.throwIfAborted()
      headers.set("Cookie", cached.cookie)
      return request(url, { ...options, headers })
    }
    cached = undefined
    if (!pending && Date.now() < retryAt) return response
    pending ??= bootstrap().catch(() => undefined).finally(() => { pending = undefined; retryAt = Date.now() + 30_000 })
    const cookie = await pending
    if (options.signal?.aborted) await response.body?.cancel()
    options.signal?.throwIfAborted()
    if (!cookie) return response
    await response.body?.cancel()
    options.signal?.throwIfAborted()
    headers.set("Cookie", cookie)
    return request(url, { ...options, headers })
  }
}
