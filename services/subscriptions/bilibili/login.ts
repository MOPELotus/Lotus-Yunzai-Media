import { createTranslator as createTextTranslator } from "../../../../../packages/i18n/index.ts";
import messageCatalog from "../../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import type { MessageFallbackContext } from "../../../../../lib/commands.ts"
import { lstat, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { stringify } from "yaml"
import { setTimeout as delay } from "node:timers/promises"
import { biliIssuedLogin, biliLocalPath, lockBiliLogin, parseBiliLocal, readBiliLocal, readBiliLogin } from "../session.ts"
import { renderBiliSubscriptionLogin } from "./login-card.ts"
import type { BiliSharedSession } from "./shared.ts"
import type { GetSubscriptionRedis, LockSubscriptionFile, SubscriptionRedis } from "../types.ts"

type LoginRequest = (url: string | URL, options?: RequestInit) => Promise<Response>
type LoginLock = NonNullable<Awaited<ReturnType<typeof lockBiliLogin>>>

interface LoginState {
  fields: ReadonlyMap<string, string>
  expiresAt?: number | null
}

type LoginStatus = { status: "absent" | "expired" | "unknown" } | { status: "active"; text: string }

interface LoginEnvelope {
  code?: unknown
  data?: {
    code?: unknown
    isLogin?: unknown
    mid?: unknown
    uname?: unknown
    money?: unknown
    level_info?: { current_level?: unknown; current_exp?: unknown; next_exp?: unknown }
    qrcode_key?: unknown
    url?: unknown
  }
}

interface BiliLoginOptions {
  getRedis: GetSubscriptionRedis
  owner: (context: MessageFallbackContext) => boolean
  signal?: AbortSignal
  directory: string
  lockFile: LockSubscriptionFile
  shared?: Pick<BiliSharedSession, "status">
  setShared?: (enabled: boolean, signal: AbortSignal) => Promise<unknown>
  fetch?: LoginRequest
  render?: typeof renderBiliSubscriptionLogin
}

const passport = "https://passport.bilibili.com"
const qrBase = passport + "/x/passport-login/web/qrcode/"
const nav = "https://api.bilibili.com/x/web-interface/nav"
const maxWait = 180_000
const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" })
const platform = $t("services.subscriptions.bilibili.login.text_ad100d5bd2")
const begin = new RegExp("^[#/]\\s*(?:扫码|添加|add)" + platform + "(动态)?登录$", "iu")
const status = new RegExp("^[#/]\\s*我的" + platform + "登录$", "iu")
const end = new RegExp("^[#/]\\s*(?:取消|删除|del)" + platform + "登录$", "iu")

const localCookie = "(?:ck|cookie)"
const bindLocal = new RegExp("^[#/]\\s*(?:绑定|添加|add)" + platform + "本地" + localCookie + "(.*)$", "iu")
const removeLocal = new RegExp("^[#/]\\s*(?:取消|删除|del)" + platform + "本地" + localCookie + "$", "iu")
const usingCookie = new RegExp("^[#/]\\s*我的" + platform + localCookie + "$", "iu")
const sharing = new RegExp("^[#/]\\s*(启用|停用)" + platform + "动态共用$", "iu")
const sharedActive = $t("services.subscriptions.bilibili.login.text_a16376ee2a")

function requestSignal(active: AbortSignal) {
  return AbortSignal.any([active, AbortSignal.timeout(10_000)])
}

async function readJson(fetch: LoginRequest, url: string | URL, signalled: AbortSignal, options: RequestInit = {}):
Promise<{ data: LoginEnvelope; headers: Headers }> {
  const response = await fetch(url, {
    ...options,
    redirect: "error", credentials: "omit", signal: requestSignal(signalled),
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.bilibili.com/", ...options.headers },
  })
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    if (response.status === 401) return { data: { code: -101 }, headers: response.headers }
    throw new Error($t("services.subscriptions.bilibili.login.text_c5c2989a08"))
  }
  return { data: await response.json() as LoginEnvelope, headers: response.headers }
}

const cookie = (fields: ReadonlyMap<string, string>) => [...fields].map(([name, value]) => name + "=" + value).join("; ")

async function checkLogin(request: LoginRequest, state: LoginState | undefined, signal: AbortSignal): Promise<LoginStatus> {
  if (!state) return { status: "absent" }
  const result = await readJson(request, nav, signal, { headers: { Cookie: cookie(state.fields) } })
  if (result.data?.code === -101 || (result.data?.code === 0 && result.data?.data?.isLogin === false)) return { status: "expired" }
  const profile = result.data?.data
  const uid = String(profile?.mid ?? "")
  if (result.data?.code !== 0 || profile?.isLogin !== true || !/^[1-9]\d{0,19}$/u.test(uid) || typeof profile.uname !== "string" ||
      (state.fields.has("DedeUserID") && state.fields.get("DedeUserID") !== uid)) {
    return { status: "unknown" }
  }
  const name = profile.uname.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 64).toWellFormed()
  const level = profile.level_info
  const rows = [$t("services.subscriptions.bilibili.login.text_43f9078cf7"), $t("services.subscriptions.bilibili.login.text_c9f36e703d") + name, "UID：" + uid]
  if (state.expiresAt === null) rows.push($t("services.subscriptions.bilibili.login.text_899f277720"))
  else if (typeof state.expiresAt === "number" && Number.isFinite(state.expiresAt)) rows.push($t("services.subscriptions.bilibili.login.text_df2433fd31") + date.format(state.expiresAt))
  for (const [label, value] of [[$t("services.subscriptions.bilibili.login.text_e8031d14f2"), profile.money], [$t("services.subscriptions.bilibili.login.text_3377171738"), level?.current_level],
    [$t("services.subscriptions.bilibili.login.text_4eb80b2d63"), level?.current_exp], [$t("services.subscriptions.bilibili.login.text_3ef1bfacd5"), level?.next_exp]]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) rows.push(label + "：" + value)
  }
  return { status: "active", text: rows.join("\n") }
}

export function biliSubscriptionLogin({ getRedis, owner, signal, directory, lockFile, shared, setShared,
  fetch: request = globalThis.fetch, render = renderBiliSubscriptionLogin }: BiliLoginOptions) {
  const filename = biliLocalPath(directory)

  async function withLocalFile(active: AbortSignal, operation: () => Promise<string>) {
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
    const lock = await lockFile(filename + ".lock.sqlite", $t("services.subscriptions.bilibili.login.text_88156c3e3d"))
    try {
      active.throwIfAborted()
      return await operation()
    } finally {
      lock.close()
    }
  }

  async function bind(value: string, active: AbortSignal) {
    const entry = parseBiliLocal(value.trim().replace(/^[:：]\s*/u, ""))
    if (!entry) return $t("services.subscriptions.bilibili.login.text_144be4431c")
    return withLocalFile(active, async () => {
      const login = await checkLogin(request, entry, active)
      if (login.status !== "active") return $t("services.subscriptions.bilibili.login.text_9e621e1f42")
      const temporary = filename + "." + crypto.randomUUID() + ".tmp"
      try {
        await writeFile(temporary, stringify(cookie(entry.fields)), { mode: 0o600, flag: "wx" })
        active.throwIfAborted()
        await rename(temporary, filename)
      } finally {
        await rm(temporary, { force: true })
      }
      return $t("services.subscriptions.bilibili.login.text_7468194740") + login.text
    })
  }

  async function clearLocal(active: AbortSignal) {
    return withLocalFile(active, async () => {
      try {
        if (!(await lstat(filename)).isFile()) return $t("services.subscriptions.bilibili.login.text_fcd5c33709")
        active.throwIfAborted()
        await unlink(filename)
        return $t("services.subscriptions.bilibili.login.text_e1e4d84d67")
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return $t("services.subscriptions.bilibili.login.text_b225525c59")
        throw error
      }
    })
  }

  async function independentStatus(redis: SubscriptionRedis | undefined, active: AbortSignal) {
    const local = await checkLogin(request, await readBiliLocal(directory), active)
    if (local.status === "active" || local.status === "unknown") return { local: true, login: local }
    const storedSession = await readBiliLogin(redis).catch(() => {
      active.throwIfAborted()
      return undefined
    })
    const stored = await checkLogin(request, storedSession, active)
    return stored.status === "absent" && local.status === "expired"
      ? { local: true, login: local }
      : { local: false, login: stored }
  }

  async function sourceStatus(redis: SubscriptionRedis | undefined, active: AbortSignal) {
    const { local, login } = await independentStatus(redis, active)
    if (login.status === "active") return (local ? $t("services.subscriptions.bilibili.login.text_9dcf563bc4") : $t("services.subscriptions.bilibili.login.text_50b55432b8")) + "\n" + login.text
    if (login.status === "unknown") return local ? $t("services.subscriptions.bilibili.login.text_e23c8b0671") : $t("services.subscriptions.bilibili.login.text_6600f6614b")
    if (await shared?.status(active) === "active") return sharedActive
    if (login.status === "expired") return $t("services.subscriptions.bilibili.login.text_c0bf35cb69")
    return $t("services.subscriptions.bilibili.login.text_d484e685bb")
  }

  async function existingLogin(redis: SubscriptionRedis | undefined, active: AbortSignal) {
    const { local, login } = await independentStatus(redis, active)
    if (login.status === "active") {
      return local ? $t("services.subscriptions.bilibili.login.text_f71c750232") + login.text : login.text + $t("services.subscriptions.bilibili.login.text_bc2ecf410c")
    }
    if (login.status === "unknown") return local ? $t("services.subscriptions.bilibili.login.text_20faab94cb") : $t("services.subscriptions.bilibili.login.text_7029f7c3e7")
    const share = await shared?.status(active)
    if (share === "active") return sharedActive
    if (share === "absent" || share === "expired") return $t("services.subscriptions.bilibili.login.text_ccbca5576b")
    if (share === "unknown") return $t("services.subscriptions.bilibili.login.text_a5ae65b23b")
  }

  async function scan(context: MessageFallbackContext, redis: SubscriptionRedis, lock: LoginLock, active: AbortSignal) {
    const checked = await checkLogin(request, await readBiliLogin(redis), active)
    if (checked.status === "active") return checked.text + $t("services.subscriptions.bilibili.login.text_bc2ecf410c")
    if (checked.status === "unknown") return $t("services.subscriptions.bilibili.login.text_7029f7c3e7")
    const applied = await readJson(request, qrBase + "generate?source=main-fe-header", active)
    const codeKey = applied.data?.data?.qrcode_key
    const appliedUrl = applied.data?.data?.url
    const link = typeof appliedUrl === "string" ? URL.parse(appliedUrl) : null
    if (applied.data?.code !== 0 || typeof codeKey !== "string" || !/^[A-Za-z0-9_-]{8,160}$/u.test(codeKey) ||
        link?.origin !== passport || link.username || link.password || link.hash || link.searchParams.get("qrcode_key") !== codeKey) {
      return $t("services.subscriptions.bilibili.login.text_eb0e08fb1b")
    }
    const png = await render(link.href).catch(() => undefined)
    active.throwIfAborted()
    let delivered = false
    await context.reply(png ? [
      { type: "text", text: $t("services.subscriptions.bilibili.login.text_2c77289415") },
      { type: "image", file: png },
    ] : $t("services.subscriptions.bilibili.login.text_178a17312a") + link.href,
    false, { onDelivered: () => { delivered = true } })
    if (!delivered) return $t("services.subscriptions.bilibili.login.text_22a38f0a99")
    const pollSignal = AbortSignal.any([active, AbortSignal.timeout(maxWait)])
    const url = new URL(qrBase + "poll")
    url.search = new URLSearchParams({ qrcode_key: codeKey, source: "main-fe-header" }).toString()
    try {
      while (!pollSignal.aborted) {
        const result = await readJson(request, url, pollSignal)
        if (result.data?.code === 0 && result.data?.data?.code === 0) {
          const issued = biliIssuedLogin(result.headers, url)
          if (!issued) return $t("services.subscriptions.bilibili.login.text_0120d01431")
          const expiry = issued.get("SESSDATA")?.seconds
          const state = { fields: new Map([...issued.values()].map(({ name, value }) => [name, value])),
            expiresAt: expiry ? Date.now() + expiry * 1000 : undefined }
          const checked = await checkLogin(request, state, pollSignal)
          if (checked.status !== "active") return $t("services.subscriptions.bilibili.login.text_c873cb2541")
          active.throwIfAborted()
          return await lock.replace(issued) ? checked.text : $t("services.subscriptions.bilibili.login.text_809783a0da")
        }
        if (result.data?.code !== 0) break
        const state = result.data?.data?.code
        if (state === 86038) return $t("services.subscriptions.bilibili.login.text_f261b5cd35")
        if (state !== 86101 && state !== 86090) break
        await delay(2_000, undefined, { signal: pollSignal })
      }
    } catch (error) {
      if (!pollSignal.aborted || active.aborted) throw error
    }
    return pollSignal.aborted ? $t("services.subscriptions.bilibili.login.text_f261b5cd35") : $t("services.subscriptions.bilibili.login.text_7cbe86b965")
  }

  async function logout(redis: SubscriptionRedis, lock: LoginLock, active: AbortSignal) {
    const state = await readBiliLogin(redis)
    if (!state) {
      if (await shared?.status(active) === "active") return $t("services.subscriptions.bilibili.login.text_b22ece6742")
      return $t("services.subscriptions.bilibili.login.text_4a4d6fc19e")
    }
    const csrf = state.fields.get("bili_jct")
    if (!csrf || !state.fields.has("DedeUserID")) return $t("services.subscriptions.bilibili.login.text_117c983fd9")
    const fields = new Map([...state.fields].filter(([name]) => name === "SESSDATA" || name === "DedeUserID" || name === "bili_jct"))
    const result = await readJson(request, passport + "/login/exit/v2", active, { method: "POST",
      headers: { Cookie: cookie(fields), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ biliCSRF: csrf }),
    })
    if (result.data?.code !== 0 && result.data?.code !== -101) return $t("services.subscriptions.bilibili.login.text_f6bdf1f19d")
    active.throwIfAborted()
    return await lock.replace() ? $t("services.subscriptions.bilibili.login.text_28f8a2412c") : $t("services.subscriptions.bilibili.login.text_cac3ad91a4")
  }

  return async (message: string, context: MessageFallbackContext) => {
    const input = message.trim()
    const starting = begin.exec(input)
    const showing = status.test(input)
    const stopping = end.test(input)
    const binding = bindLocal.exec(input)
    const clearing = removeLocal.test(input)
    const source = usingCookie.test(input)
    const switchSharing = setShared && sharing.exec(input)
    if (!starting && !showing && !stopping && !binding && !clearing && !source && !switchSharing) return
    if (context.isDelegated || !owner(context)) return $t("services.subscriptions.bilibili.login.text_18c0917265")
    const privateSignal = context.privateCredentialSignal
    if (context.message_type !== "private" || !privateSignal) return $t("services.subscriptions.bilibili.login.text_ea466599c5")
    const active = signal ? AbortSignal.any([signal, privateSignal]) : privateSignal
    const redis = getRedis()
    let lock: LoginLock | undefined
    try {
      active.throwIfAborted()
      if (switchSharing && setShared) {
        const enabled = switchSharing[1] === "启用"
        await setShared(enabled, active)
        return enabled ? $t("services.subscriptions.bilibili.login.text_a5ca477255") : $t("services.subscriptions.bilibili.login.text_a506072bc2")
      }
      if (binding?.[1]) return await bind(binding[1], active)
      if (clearing) return await clearLocal(active)
      if (source || showing) return await sourceStatus(redis, active)
      if (starting && !starting[1]) {
        const existing = await existingLogin(redis, active)
        if (existing) return existing
      }
      if (!redis) return $t("services.subscriptions.bilibili.login.text_0f6f31acf0")
      lock = await lockBiliLogin(redis)
      if (!lock) return $t("services.subscriptions.bilibili.login.text_a64bc81145")
      return starting ? await scan(context, redis, lock, active) : await logout(redis, lock, active)
    } catch {
      if (!active.aborted) return $t("services.subscriptions.bilibili.login.text_4d29ff7493")
    } finally {
      await lock?.close().catch(() => {})
    }
  }
}
