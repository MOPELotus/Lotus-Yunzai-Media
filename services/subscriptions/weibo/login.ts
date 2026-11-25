import { createTranslator as createTextTranslator } from "../../../../../packages/i18n/index.ts";
import messageCatalog from "../../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import type { MessageFallbackContext } from "../../../../../lib/commands.ts"
import { clearWeiboLogin, readWeiboLogin, type SubscriptionSession } from "../session.ts"
import type { GetSubscriptionRedis, SubscriptionRedis } from "../types.ts"

type LoginRequest = (url: URL, options?: RequestInit) => Promise<Response>
type StoredLogin = NonNullable<Awaited<ReturnType<typeof readWeiboLogin>>>

interface LoginEnvelope {
  data?: { login?: unknown; uid?: unknown; user_token?: unknown }
  user?: { id?: unknown; idstr?: unknown; screen_name?: unknown; svip?: unknown; follow_count?: unknown }
}

interface WeiboLoginOptions {
  getRedis: GetSubscriptionRedis
  session: SubscriptionSession
  owner: (context: MessageFallbackContext) => boolean
  signal?: AbortSignal
  fetch?: LoginRequest
}

const base = "https://m.weibo.cn"
const show = /^[#/]\s*我的(?:微博|weibo)登录$/iu
const remove = /^[#/]\s*(?:取消|删除|del)(?:微博|weibo)登录$/iu
const tokenValue = /^[A-Za-z0-9_.%+=/-]{1,4096}$/u

function userId(value: unknown) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return
  const id = String(value ?? "")
  if (/^[1-9]\d{0,20}$/u.test(id)) return id
}

async function get(request: LoginRequest, session: SubscriptionSession, state: StoredLogin, pathname: URL,
  active: AbortSignal, extra: Record<string, string> = {}): Promise<{ expired?: boolean; data?: LoginEnvelope }> {
  active.throwIfAborted()
  const url = new URL(pathname, base)
  const deadline = AbortSignal.any([active, AbortSignal.timeout(10_000)])
  const response = await request(url, {
    method: "GET", redirect: "error", credentials: "omit",
    signal: deadline,
    headers: session.headers(state, { Accept: "application/json", Referer: base + "/", "User-Agent": "Mozilla/5.0", ...extra }),
  })
  if (deadline.aborted || !response.ok) {
    void response.body?.cancel().catch(() => {})
    deadline.throwIfAborted()
    if (response.status === 401) return { expired: true }
    return {}
  }
  const data = await response.json() as LoginEnvelope
  deadline.throwIfAborted()
  await session.rotate(state, url, response.headers)
  active.throwIfAborted()
  return { data }
}

export function weiboSubscriptionLogin({ getRedis, session, owner, signal, fetch: request = globalThis.fetch }: WeiboLoginOptions) {
  async function status(redis: SubscriptionRedis, active: AbortSignal) {
    const url = new URL("/api/config", base)
    const state = await readWeiboLogin(redis, url)
    if (!state) return $t("services.subscriptions.weibo.login.text_746642a82f")
    const result = await get(request, session, state, url, active)
    const config = result.data?.data
    if (result.expired || config?.login === false) return $t("services.subscriptions.weibo.login.text_6281d77c48")
    const uid = userId(config?.uid)
    if (config?.login !== true || !uid) return $t("services.subscriptions.weibo.login.text_a0ec373a6c")
    const rows = [$t("services.subscriptions.weibo.login.text_a78a2aba64"), "UID：" + uid]
    const profileUrl = new URL("/profile/info", base)
    profileUrl.searchParams.set("uid", uid)
    const token = config.user_token
    if (typeof token === "string" && tokenValue.test(token)) {
      try {
        const current = await readWeiboLogin(redis, profileUrl)
        if (!current || current.proof.key !== state.proof.key || current.proof.value !== state.proof.value) return rows.join("\n")
        const detail = await get(request, session, current, profileUrl, active, { "x-h5-user-token": token })
        const user = detail.data?.user
        if (user && userId(user.id ?? user.idstr) === uid) {
          if (typeof user.screen_name === "string" && user.screen_name.trim()) {
            const name = user.screen_name.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 80).toWellFormed()
            rows.push($t("services.subscriptions.weibo.login.text_c9f36e703d") + name)
          }
          for (const [label, value] of [[$t("services.subscriptions.weibo.login.text_02fd80206a"), user.svip], [$t("services.subscriptions.weibo.login.text_eb137dee4c"), user.follow_count]]) {
            if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) rows.push(label + "：" + value)
          }
        }
      } catch {
        active.throwIfAborted()
      }
    }
    return rows.join("\n")
  }

  return async (message: string, context: MessageFallbackContext) => {
    const input = message.trim()
    const showing = show.test(input)
    const removing = remove.test(input)
    if (!showing && !removing) return
    if (context.isDelegated || !owner(context)) return $t("services.subscriptions.weibo.login.text_d9c6e45055")
    const privateSignal = context.privateCredentialSignal
    if (context.message_type !== "private" || !privateSignal) return $t("services.subscriptions.weibo.login.text_085e77f43d")
    const active = signal ? AbortSignal.any([signal, privateSignal]) : privateSignal
    const redis = getRedis()
    if (!redis) return $t("services.subscriptions.weibo.login.text_0f6f31acf0")
    try {
      active.throwIfAborted()
      if (showing) return await status(redis, active)
      const result = await clearWeiboLogin(redis)
      if (result === "cleared") return $t("services.subscriptions.weibo.login.text_4f0c44b562")
      if (result === "absent") return $t("services.subscriptions.weibo.login.text_746642a82f")
      return $t("services.subscriptions.weibo.login.text_246387c5fa")
    } catch {
      if (!active.aborted) return $t("services.subscriptions.weibo.login.text_5ae41fbcf7")
    }
  }
}
