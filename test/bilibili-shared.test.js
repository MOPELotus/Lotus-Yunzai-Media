import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lockFile } from "../../../lib/file-lock.ts"
import { BilibiliService } from "../services/bilibili/service.js"
import { createBiliProvider } from "../services/subscriptions/bilibili/index.js"
import { biliSubscriptionLogin } from "../services/subscriptions/bilibili/login.js"
import { biliSharedSession } from "../services/subscriptions/bilibili/shared.js"
import { createSubscriptionConfig } from "../services/subscriptions/config.js"
import { subscriptionSession } from "../services/subscriptions/session.js"

const alias = "synthetic-video"
const rawPost = {
  id_str: "117", type: "DYNAMIC_TYPE_WORD",
  modules: { module_author: { mid: "12", name: "合成作者", pub_ts: 1770000000 },
    module_dynamic: { desc: { text: "合成动态" } } },
}

test("动态先用原会话，失效才共用视频账号，限制响应所属别名与回退", async () => {
  const folder = await mkdtemp(join(tmpdir(), "lotus-bili-shared-"))
  let registered = true
  let feedError, outputAlias = alias, onFeed
  let enabled = true, directExpired = false
  let count = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const u = new URL(request.url)
    expect(request.headers.has("cookie")).toBe(false)
    expect(request.headers.has("authorization")).toBe(false)
    expect(request.headers.has("x-tuneweave-credential")).toBe(false)
    count.push(u.pathname)
    if (u.pathname === "/v1/capabilities") return Response.json({ ok: true,
      data: [{ platform: "bilibili", registered, capabilities: registered ? ["bilibili_space_feed"] : [] }] })
    expect(u.searchParams.get("account")).toBe(alias)
    expect(request.method).toBe("GET")
    if (u.pathname === "/v1/auth/session") return Response.json({ ok: true,
      data: { platform: "bilibili", account: alias, authenticated: true, user_id: "90" }, meta: { platform: "bilibili", account: alias } })
    expect(u.pathname).toBe("/v1/bilibili/users/12/dynamics")
    if (feedError) return Response.json({ ok: false, error: { code: feedError } }, { status: 422 })
    onFeed?.()
    return Response.json({ ok: true, data: { items: [rawPost], authenticated: true },
      meta: { platform: "bilibili", account: outputAlias } })
  } })
  try {
    const service = new BilibiliService({ accountFile: join(folder, "account.yaml"), tuneweaveConfig: {
      api_url: "http://127.0.0.1:" + server.port,
    } })
    await service.saveAccount({ tuneweave_account: alias, cookie: "SESSDATA=fixture-video-cookie" })
    const createShared = () => biliSharedSession({ enabled: async () => enabled, createService: async () => service })
    const provider = (shared) => createBiliProvider({ shared, session: subscriptionSession("bilibili", folder, () => null),
      fetch: async (_, { headers }) => {
        const cookie = new Headers(headers).get("cookie")
        count.push(cookie ? "local" : "public")
        if (cookie && directExpired) return Response.json({ code: -101 })
        return Response.json({ code: 0, data: { items: cookie ? [rawPost] : [] } })
      } })
    await mkdir(join(folder, "yuki-plugin"))
    await writeFile(join(folder, "yuki-plugin", "biliCookie.yaml"), '"SESSDATA=fixture-native"')
    const shared = createShared()
    expect((await provider(shared).fetchPosts("12")).map(post => post.id)).toEqual(["117"])
    expect(count).toEqual(["local"])
    directExpired = true
    count = []
    expect((await provider(shared).fetchPosts("12")).map(post => post.id)).toEqual(["117"])
    expect(count).toEqual(["local", "/v1/capabilities", "/v1/bilibili/users/12/dynamics"])
    expect(await shared.status()).toBe("active")
    feedError = "authentication_required"
    count = []
    expect(await provider(shared).fetchPosts("12")).toEqual([])
    expect(count).toEqual(["local", "/v1/bilibili/users/12/dynamics", "public"])
    feedError = "upstream_error"
    count = []
    await expect(provider(shared).fetchPosts("12")).rejects.toThrow("upstream_error")
    expect(count).not.toContain("public")
    feedError = undefined
    outputAlias = "other"
    await expect(provider(shared).fetchPosts("12")).rejects.toThrow("未确认")
    outputAlias = alias
    onFeed = () => { enabled = false }
    await expect(provider(shared).fetchPosts("12")).rejects.toThrow("已变更")
    count = []
    expect(await provider(shared).fetchPosts("12")).toEqual([])
    expect(count).toEqual(["local", "public"])
    enabled = true
    onFeed = undefined
    registered = false
    count = []
    expect(await provider(createShared()).fetchPosts("12")).toEqual([])
    expect(count).toEqual(["local", "/v1/capabilities", "public"])
  } finally {
    server.stop(true)
    await rm(folder, { recursive: true, force: true })
  }
})

test("B 站共用登录入口不重复扫码，停用只改动态配置", async () => {
  const folder = await mkdtemp(join(tmpdir(), "lotus-bili-login-command-"))
  const config = createSubscriptionConfig(folder, lockFile)
  let state = "active", upstream = 0
  const redis = { mGet: async keys => keys.map(() => null), set: async () => "OK", eval: async () => 1 }
  const handler = biliSubscriptionLogin({ getRedis: () => redis, owner: context => context.isMaster,
    directory: folder, lockFile, shared: { status: async () => state },
    setShared: (value, signal) => config.editSettings("bilibili", () => ({ sharedBiliLogin: value }), signal),
    fetch: async () => { upstream++; return Response.json({ code: -1 }) },
  })
  const owner = { isMaster: true, message_type: "private", privateCredentialSignal: new AbortController().signal }
  try {
    expect(await handler("#扫码B站登录", owner)).toContain("无需再扫码")
    expect(await handler("#我的B站登录", owner)).toContain("共用视频登录")
    expect(await handler("#删除B站登录", owner)).toContain("#停用B站动态共用")
    expect(upstream).toBe(0)
    expect(await handler("#停用B站动态共用", { ...owner, isDelegated: true })).toContain("仅机器人主人")
    expect((await config.settings("bilibili")).sharedBiliLogin).toBe(true)
    expect(await handler("#停用B站动态共用", owner)).toContain("视频和独立动态登录均保留")
    expect((await config.settings("bilibili")).sharedBiliLogin).toBe(false)
    expect(await handler("#启用B站动态共用", owner)).toContain("已允许")
    expect((await config.settings("bilibili")).sharedBiliLogin).toBe(true)
    state = "absent"
    expect(await handler("#扫码B站登录", owner)).toContain("#B站登录")
    expect(upstream).toBe(0)
    expect(await handler("#扫码B站动态登录", owner)).toContain("未能取得")
    state = "unavailable"
    expect(await handler("#扫码B站登录", owner)).toContain("未能取得")
    expect(upstream).toBe(2)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
