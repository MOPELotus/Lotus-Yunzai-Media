import { lstat, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { stringify } from "yaml"
import { setTimeout as delay } from "node:timers/promises"
import { biliIssuedLogin, biliLocalPath, lockBiliLogin, parseBiliLocal, readBiliLocal, readBiliLogin } from "../session.js"
import { renderBiliSubscriptionLogin } from "./login-card.js"

const passport = "https://passport.bilibili.com"
const qrBase = passport + "/x/passport-login/web/qrcode/"
const nav = "https://api.bilibili.com/x/web-interface/nav"
const maxWait = 180_000
const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" })
const platform = "(?:哔哩哔哩|哔哩|bilibili|bili|b站)"
const begin = new RegExp("^[#/]\\s*(?:扫码|添加|add)" + platform + "(动态)?登录$", "iu")
const status = new RegExp("^[#/]\\s*我的" + platform + "登录$", "iu")
const end = new RegExp("^[#/]\\s*(?:取消|删除|del)" + platform + "登录$", "iu")

const localCookie = "(?:ck|cookie)"
const bindLocal = new RegExp("^[#/]\\s*(?:绑定|添加|add)" + platform + "本地" + localCookie + "(.*)$", "iu")
const removeLocal = new RegExp("^[#/]\\s*(?:取消|删除|del)" + platform + "本地" + localCookie + "$", "iu")
const usingCookie = new RegExp("^[#/]\\s*我的" + platform + localCookie + "$", "iu")
const sharing = new RegExp("^[#/]\\s*(启用|停用)" + platform + "动态共用$", "iu")
const sharedActive = "B 站动态正在共用视频登录，无需再扫码。"

function requestSignal(active) {
  return AbortSignal.any([active, AbortSignal.timeout(10_000)])
}

async function readJson(fetch, url, signalled, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "error", credentials: "omit", signal: requestSignal(signalled),
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.bilibili.com/", ...options.headers },
  })
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    if (response.status === 401) return { data: { code: -101 }, headers: response.headers }
    throw new Error("登录服务不可用。")
  }
  return { data: await response.json(), headers: response.headers }
}

const cookie = (fields) => [...fields].map(([name, value]) => name + "=" + value).join("; ")

async function checkLogin(request, state, signal) {
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
  const rows = ["B站动态订阅已登录", "昵称：" + name, "UID：" + uid]
  if (state.expiresAt === null) rows.push("本地会话无固定到期时间")
  else if (Number.isFinite(state.expiresAt)) rows.push("本地会话有效期至：" + date.format(state.expiresAt))
  for (const [label, value] of [["硬币", profile.money], ["等级", level?.current_level],
    ["当前经验", level?.current_exp], ["升级所需经验", level?.next_exp]]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) rows.push(label + "：" + value)
  }
  return { status: "active", text: rows.join("\n") }
}

export function biliSubscriptionLogin({ getRedis, owner, signal, directory, lockFile, shared, setShared,
  fetch: request = globalThis.fetch, render = renderBiliSubscriptionLogin }) {
  const filename = biliLocalPath(directory)

  async function withLocalFile(active, operation) {
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
    const lock = await lockFile(filename + ".lock.sqlite", "B 站本地动态会话")
    try {
      active.throwIfAborted()
      return await operation()
    } finally {
      lock.close()
    }
  }

  async function bind(value, active) {
    const entry = parseBiliLocal(value.trim().replace(/^[:：]\s*/u, ""))
    if (!entry) return "请输入 B 站本地 Cookie，至少要包含有效的 SESSDATA。"
    return withLocalFile(active, async () => {
      const login = await checkLogin(request, entry, active)
      if (login.status !== "active") return "B 站未确认此 Cookie 的登录，原文件已保留。"
      const temporary = filename + "." + crypto.randomUUID() + ".tmp"
      try {
        await writeFile(temporary, stringify(cookie(entry.fields)), { mode: 0o600, flag: "wx" })
        active.throwIfAborted()
        await rename(temporary, filename)
      } finally {
        await rm(temporary, { force: true })
      }
      return "B 站本地动态 Cookie 已绑定。\n" + login.text
    })
  }

  async function clearLocal(active) {
    return withLocalFile(active, async () => {
      try {
        if (!(await lstat(filename)).isFile()) return "本地 Cookie 路径须为普通文件。"
        active.throwIfAborted()
        await unlink(filename)
        return "B 站本地动态 Cookie 已删除。"
      } catch (error) {
        if (error.code === "ENOENT") return "当前没有 B 站本地动态 Cookie。"
        throw error
      }
    })
  }

  async function sourceStatus(redis, active) {
    const local = await checkLogin(request, await readBiliLocal(directory), active)
    if (local.status === "active") return "当前使用 B 站本地动态 Cookie。\n" + local.text
    if (local.status === "unknown") return "无法确认 B 站本地 Cookie 的状态。"
    const stored = await checkLogin(request, await readBiliLogin(redis), active)
    if (stored.status === "active") return "当前使用 B 站扫码会话。\n" + stored.text
    if (stored.status === "unknown") return "无法确认 B 站扫码会话状态。"
    if (await shared?.status(active) === "active") return sharedActive
    if (local.status === "expired" || stored.status === "expired") return "B 站动态会话已失效，当前使用公开读取。"
    return "当前使用 B 站公开读取。"
  }

  async function scan(context, lock, active, independent) {
    const checked = await checkLogin(request, await readBiliLogin(getRedis()), active)
    if (checked.status === "active") return checked.text + "\n如需更换，请先发送 #删除B站登录。"
    if (checked.status === "unknown") return "无法确认原 B 站动态登录状态，请稍后重试。"
    if (!independent) {
      const share = await shared?.status(active)
      if (share && share !== "unavailable") {
        const local = await checkLogin(request, await readBiliLocal(directory), active)
        if (local.status === "active") return "当前动态已使用本地 B 站会话。" + "\n" + local.text
        if (local.status === "unknown") return "无法确认原 B 站本地会话状态，请稍后重试。"
      }
      if (share === "active") return sharedActive
      if (share === "absent" || share === "expired") return "请发送 #B站登录，扫码一次即可用于视频和动态。"
      if (share === "unknown") return "无法确认 B 站视频登录，请稍后重试。需要独立账号可发送 #扫码B站动态登录。"
    }
    const applied = await readJson(request, qrBase + "generate?source=main-fe-header", active)
    const codeKey = applied.data?.data?.qrcode_key
    const link = URL.parse(applied.data?.data?.url ?? "")
    if (applied.data?.code !== 0 || typeof codeKey !== "string" || !/^[A-Za-z0-9_-]{8,160}$/u.test(codeKey) ||
        link?.origin !== passport || link.username || link.password || link.hash || link.searchParams.get("qrcode_key") !== codeKey) {
      return "未能取得 B 站登录二维码，请稍后重试。"
    }
    const png = await render(link.href).catch(() => undefined)
    active.throwIfAborted()
    let delivered = false
    await context.reply(png ? [
      { type: "text", text: "请在 3 分钟内使用哔哩哔哩 App 扫码确认。" },
      { type: "image", file: png },
    ] : "二维码图片暂不可用。请在 3 分钟内打开 B 站登录链接。\n" + link.href,
    false, { onDelivered: () => { delivered = true } })
    if (!delivered) return "B 站登录二维码送达未确认，请重试。"
    const pollSignal = AbortSignal.any([active, AbortSignal.timeout(maxWait)])
    const url = new URL(qrBase + "poll")
    url.search = new URLSearchParams({ qrcode_key: codeKey, source: "main-fe-header" }).toString()
    try {
      while (!pollSignal.aborted) {
        const result = await readJson(request, url, pollSignal)
        if (result.data?.code === 0 && result.data?.data?.code === 0) {
          const issued = biliIssuedLogin(result.headers, url)
          if (!issued) return "B 站确认了扫码，但未返回有效会话，请重试。"
          const expiry = issued.get("SESSDATA")?.seconds
          const state = { fields: new Map([...issued.values()].map(({ name, value }) => [name, value])),
            expiresAt: expiry ? Date.now() + expiry * 1000 : undefined }
          const checked = await checkLogin(request, state, pollSignal)
          if (checked.status !== "active") return "B 站扫码后的账号校验未通过，请重试。"
          active.throwIfAborted()
          return await lock.replace(issued) ? checked.text : "扫码期间 B 站会话发生变更，请查询当前状态。"
        }
        if (result.data?.code !== 0) break
        const state = result.data?.data?.code
        if (state === 86038) return "B 站登录二维码已过期，请重新扫码。"
        if (state !== 86101 && state !== 86090) break
        await delay(2_000, undefined, { signal: pollSignal })
      }
    } catch (error) {
      if (!pollSignal.aborted || active.aborted) throw error
    }
    return pollSignal.aborted ? "B 站登录二维码已过期，请重新扫码。" : "B 站扫码登录未完成，请稍后重试。"
  }

  async function logout(lock, active) {
    const state = await readBiliLogin(getRedis())
    if (!state) {
      if (await shared?.status(active) === "active") return "没有独立的 B 站扫码会话。视频登录已保留，如需停用共用请发送 #停用B站动态共用。"
      return "当前没有 B 站扫码会话。"
    }
    const csrf = state.fields.get("bili_jct")
    if (!csrf || !state.fields.has("DedeUserID")) return "无法确认当前 B 站扫码会话，请重新登录后再退出。"
    const fields = new Map([...state.fields].filter(([name]) => name === "SESSDATA" || name === "DedeUserID" || name === "bili_jct"))
    const result = await readJson(request, passport + "/login/exit/v2", active, { method: "POST",
      headers: { Cookie: cookie(fields), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ biliCSRF: csrf }),
    })
    if (result.data?.code !== 0 && result.data?.code !== -101) return "B 站未确认退出登录，请稍后重试。"
    active.throwIfAborted()
    return await lock.replace() ? "B 站扫码登录已退出。" : "原会话已处理，已保留后来更新的 B 站登录。"
  }

  return async (message, context) => {
    const input = message.trim()
    const starting = begin.exec(input)
    const showing = status.test(input)
    const stopping = end.test(input)
    const binding = bindLocal.exec(input)
    const clearing = removeLocal.test(input)
    const source = usingCookie.test(input)
    const switchSharing = setShared && sharing.exec(input)
    if (!starting && !showing && !stopping && !binding && !clearing && !source && !switchSharing) return
    if (context.isDelegated || !owner(context)) return "仅机器人主人可管理 B 站动态登录。"
    const privateSignal = context.privateCredentialSignal
    if (context.message_type !== "private" || !privateSignal) return "请在与机器人的好友私聊中管理 B 站动态登录。"
    const active = signal ? AbortSignal.any([signal, privateSignal]) : privateSignal
    const redis = getRedis()
    let lock
    try {
      active.throwIfAborted()
      if (switchSharing) {
        const enabled = switchSharing[1] === "启用"
        await setShared(enabled, active)
        return enabled ? "已允许 B 站动态在独立会话不可用时共用视频登录。" : "已停用 B 站动态共用。视频和独立动态登录均保留。"
      }
      if (binding) return await bind(binding[1], active)
      if (clearing) return await clearLocal(active)
      if (source) return await sourceStatus(redis, active)
      if (!redis) return "动态登录存储未连接。"
      if (showing) {
        const result = await checkLogin(request, await readBiliLogin(redis), active)
        if (result.status === "active") return result.text
        if (result.status !== "unknown" && await shared?.status(active) === "active") {
          return "B 站动态可共用视频登录。发送 #我的B站CK 可查看实际来源。"
        }
        if (result.status === "absent") return "当前没有 B 站扫码会话。"
        return result.status === "expired" ? "B 站扫码会话已失效，请重新扫码。" : "无法确认 B 站动态登录状态。"
      }
      lock = await lockBiliLogin(redis)
      if (!lock) return "已有 B 站登录操作在进行，请稍后再试。"
      return starting ? await scan(context, lock, active, Boolean(starting[1])) : await logout(lock, active)
    } catch {
      if (!active.aborted) return "B 站动态登录操作未完成，请稍后重试。"
    } finally {
      await lock?.close().catch(() => {})
    }
  }
}
