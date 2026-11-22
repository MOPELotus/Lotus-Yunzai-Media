import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import YAML from "yaml"
import { lockFile } from "../../../lib/file-lock.ts"
import { panelMediaSubscriptionSettings } from "../services/subscriptions/panel.ts"
import { createSubscriptionConfig } from "../services/subscriptions/config.ts"

const url = "http://example.test/panel/api/settings/native/bilibili-subscriptions"
const read = new Request(url)
const group = (chat, uid, types = []) => ({ kind: "group", chat, uid, types })
const privateRoute = (chat, uid, types = []) => ({ kind: "private", chat, uid, types })
const put = (previous, routes) => new Request(url, {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previous, values: { routes } }),
})

async function fixture(run) {
  const work = await mkdtemp(join(tmpdir(), "lotus-subscription-panel-"))
  const data = join(work, "data")
  const settings = join(data, "yuki-plugin/config/bilibili")
  await mkdir(settings, { recursive: true })
  const base = join(settings, "push.yaml")
  const override = join(settings, "push.guoba.support.yaml")
  const original = "# 已存在的订阅\ngroup:\n  77:\n    - {bot_id: 99, uid: 12, name: 测试甲, type: [], metadata: fixed}\n" +
    "    - {bot_id: 88, uid: 12, name: 别的机器人, type: []}\nprivate:\n  43:\n    - {bot_id: 99, uid: 15, name: 另外的主人, type: []}\n"
  await writeFile(base, original)
  await writeFile(override, original)
  const signal = new AbortController()
  const gateway = {
    botId: 99, ownerId: 42, signal: signal.signal,
    authorized: () => true, groups: async () => [{ id: 77 }, { id: 78 }],
    friends: async () => [{ user_id: 42 }, { user_id: 43 }],
  }
  let panelActive = true
  const create = (platform) => {
    const handler = panelMediaSubscriptionSettings(pathToFileURL(work + "/"), platform, request =>
      request.headers.has("Authorization") ? undefined : gateway)
    return request => handler(request, () => panelActive)
  }
  const config = createSubscriptionConfig(data, lockFile)
  try {
    await run({
      base, override, original, gateway, signal, send: create("bilibili"), sendWeibo: create("weibo"), config,
      settingsLock: join(settings, ".push-lock.sqlite"),
      closePanel: () => { panelActive = false },
    })
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

test("媒体面板只列当前机器人订阅，保留其他机器人的 YAML、同 UID 与个人附加字段", async () => {
  await fixture(async ({ base, override, original, send, config }) => {
    const response = await send(read.clone())
    expect(response.status).toBe(200)
    const { values, fields } = await response.json()
    expect(values).toEqual({ routes: [group("77", "12"), privateRoute("43", "15")] })
    expect(fields[0]).toMatchObject({ key: "routes", type: "json" })
    const next = [
      group("77", "12", ["DYNAMIC_TYPE_AV"]), group("78", "16"), privateRoute("42", "27"), privateRoute("43", "15"),
    ]
    expect(await (await send(put(values, next))).json()).toMatchObject({ values: { routes: next } })
    const saved = await readFile(override, "utf8")
    expect(saved).toContain("# 已存在的订阅")
    expect(YAML.parse(saved).group["77"]).toEqual([
      { bot_id: 99, uid: 12, name: "测试甲", type: ["DYNAMIC_TYPE_AV"], metadata: "fixed" },
      { bot_id: 88, uid: 12, name: "别的机器人", type: [] },
    ])
    expect(await readFile(base, "utf8")).toBe(original)
    expect(await config.routes("bilibili")).toContainEqual({ ...group("78", "16"), bot: "99", name: "16" })
    expect(await config.routes("bilibili")).toContainEqual({ ...privateRoute("42", "27"), bot: "99", name: "27" })
    const { values: updated } = await (await send(read.clone())).json()
    expect((await send(put(updated, next.slice(1)))).status).toBe(200)
    expect(YAML.parse(await readFile(override, "utf8")).group["77"]).toEqual([
      { bot_id: 88, uid: 12, name: "别的机器人", type: [] },
    ])
  })
})

test("媒体面板拒绝无会话的令牌、越权会话、重复条目、机器人替换及未知类别", async () => {
  await fixture(async ({ override, original, send }) => {
    const bearer = new Request(url, { headers: { Authorization: "Bearer fixture" } })
    expect((await send(bearer)).status).toBe(403)
    const { values } = await (await send(read.clone())).json()
    for (const row of [group("79", "10"), privateRoute("43", "10")]) {
      expect((await send(put(values, [...values.routes, row]))).status).toBe(403)
    }
    expect((await send(put(values, values.routes.filter(route => route.kind === "group")))).status).toBe(403)
    for (const row of [group("78", "10", ["arbitrary"]), group("77", "12"),
      group("78", "10", ["DYNAMIC_TYPE_AV", "DYNAMIC_TYPE_AV"]), { ...group("78", "10"), bot: "88" }]) {
      expect((await send(put(values, [...values.routes, row]))).status).toBe(400)
    }
    expect(await readFile(override, "utf8")).toBe(original)
  })
})

test("浏览器和聊天更新用同一配置，保留相邻机器人并拒绝旧当前账户快照", async () => {
  await fixture(async ({ send, config }) => {
    const { values } = await (await send(read.clone())).json()
    await config.update("bilibili", { kind: "group", chat: "77", bot: "88" }, "33", "add", [], [], "相邻机器人新增")
    const edited = [...values.routes, group("78", "20")]
    expect((await send(put(values, edited))).status).toBe(200)
    const { values: stale } = await (await send(read.clone())).json()
    await config.update("bilibili", { kind: "group", chat: "78", bot: "99" }, "22", "add", [], [], "本机器人新增")
    expect((await send(put(stale, edited.slice(1)))).status).toBe(409)
    expect(await config.routes("bilibili")).toContainEqual({ ...group("78", "22"), bot: "99", name: "本机器人新增" })
    expect(await config.routes("bilibili")).toContainEqual({ ...group("77", "33"), bot: "88", name: "相邻机器人新增" })
  })
})

test("微博订阅使用自己的目标文件，并拒绝 B 站直播类别", async () => {
  await fixture(async ({ sendWeibo, config }) => {
    const { values } = await (await sendWeibo(read.clone())).json()
    expect(values.routes).toEqual([])
    expect((await sendWeibo(put(values, [group("78", "15", ["DYNAMIC_TYPE_LIVE_RCMD"])]))).status).toBe(400)
    const next = group("78", "15", ["DYNAMIC_TYPE_ARTICLE"])
    expect((await sendWeibo(put(values, [next]))).status).toBe(200)
    expect(await config.routes("weibo")).toEqual([{ ...next, bot: "99", name: "15" }])
    expect((await config.routes("bilibili")).length).toBe(3)
  })
})

test("媒体面板等候验证目标时断开会话，原配置保持不变", async () => {
  await fixture(async ({ gateway, signal, send, override, original }) => {
    const { values } = await (await send(read.clone())).json()
    gateway.groups = async () => {
      signal.abort()
      return [{ id: 78 }]
    }
    expect((await send(put(values, [...values.routes, group("78", "20")]))).status).toBe(403)
    expect(await readFile(override, "utf8")).toBe(original)
  })
})

test("媒体面板排队等写入锁时会话被撤销，释放锁后仍拒绝写入", async () => {
  await fixture(async ({ gateway, send, settingsLock, closePanel, override, original }) => {
    const { values } = await (await send(read.clone())).json()
    const queried = Promise.withResolvers()
    gateway.groups = async () => {
      queried.resolve()
      return [{ id: 78 }]
    }
    const held = await lockFile(settingsLock, "隔离订阅夹具")
    const pending = send(put(values, [...values.routes, group("78", "20")]))
    try {
      await queried.promise
      await Bun.sleep(30)
      closePanel()
    } finally {
      held.close()
    }
    expect((await pending).status).toBe(403)
    expect(await readFile(override, "utf8")).toBe(original)
  })
})
