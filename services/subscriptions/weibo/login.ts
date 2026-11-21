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
    if (!state) return "当前没有微博登录会话。"
    const result = await get(request, session, state, url, active)
    const config = result.data?.data
    if (result.expired || config?.login === false) return "微博未登录或会话已失效。"
    const uid = userId(config?.uid)
    if (config?.login !== true || !uid) return "无法确认微博登录状态。"
    const rows = ["微博动态订阅已登录", "UID：" + uid]
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
            rows.push("昵称：" + name)
          }
          for (const [label, value] of [["SVIP 等级", user.svip], ["关注", user.follow_count]]) {
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
    if (context.isDelegated || !owner(context)) return "仅机器人主人可管理微博动态登录。"
    const privateSignal = context.privateCredentialSignal
    if (context.message_type !== "private" || !privateSignal) return "请在与机器人的好友私聊中管理微博动态登录。"
    const active = signal ? AbortSignal.any([signal, privateSignal]) : privateSignal
    const redis = getRedis()
    if (!redis) return "动态登录存储未连接。"
    try {
      active.throwIfAborted()
      if (showing) return await status(redis, active)
      const result = await clearWeiboLogin(redis)
      if (result === "cleared") return "微博动态登录会话已从本机清除。"
      if (result === "absent") return "当前没有微博登录会话。"
      return "微博会话刚发生变更，请重新查询后操作。"
    } catch {
      if (!active.aborted) return "微博动态登录操作未完成，请稍后重试。"
    }
  }
}
