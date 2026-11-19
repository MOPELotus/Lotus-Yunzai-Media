import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import YAML from "yaml"
import { lockFile } from "../../../lib/file-lock.ts"
import { supportGuoba } from "../guoba.support.js"
import { createSubscriptionConfig } from "../services/subscriptions/config.js"
import { useDynamicForward } from "../services/subscriptions/delivery.js"

const Result = {
  ok: () => ({ ok: true }),
  error: (_message, status) => ({ ok: false, status }),
}
const defaults = {
  pushMsgMode: 1, mergeTextPic: 1, forwardSendDynamic: 1, maxPicsForSingleMsg: 2, maxTextLengthForSingleMsg: 300,
}

test("锅巴沿用 Yuki 默认值和旧配置，保存后下次推送使用覆盖文件", async () => {
  const data = await mkdtemp(join(tmpdir(), "lotus-yuki-guoba-"))
  try {
    const { configInfo: form } = supportGuoba(data)
    expect(await form.getConfigData()).toEqual({ bilibili: defaults, weibo: defaults })
    expect(existsSync(join(data, "yuki-plugin"))).toBe(false)

    const directory = join(data, "yuki-plugin", "config", "bilibili")
    await mkdir(directory, { recursive: true })
    const primary = join(directory, "config.yaml"), override = join(directory, "config.guoba.support.yaml")
    const original = "# 非面板配置保留\npushMsgMode: true\nmergeTextPic: 0\nforwardSendDynamic: 0\nmaxPicsForSingleMsg: 7\ncheckDynamicCD: '*/23 * * * *'\ncustom: { color: teal }\n"
    await writeFile(primary, original)

    const store = createSubscriptionConfig(data, lockFile)
    const nodes = [{ payloads: [[{ type: "image", file: "fixture.png" }]] }]
    expect(useDynamicForward(nodes, await store.settings("bilibili"))).toBe(false)
    expect(await form.getConfigData()).toEqual({ bilibili: {
      pushMsgMode: 1, mergeTextPic: 0, forwardSendDynamic: 0, maxPicsForSingleMsg: 7, maxTextLengthForSingleMsg: 300,
    }, weibo: defaults })
    expect(await form.setConfigData({ "bilibili.forwardSendDynamic": 0 }, { Result })).toEqual({ ok: true })
    expect(existsSync(override)).toBe(false)
    expect(await form.setConfigData({ "bilibili.pushMsgMode": 0, "bilibili.maxPicsForSingleMsg": 0.5 },
      { Result })).toEqual({ ok: false, status: 422 })
    expect(existsSync(override)).toBe(false)

    expect(await form.setConfigData({ "bilibili.pushMsgMode": 0, "bilibili.maxPicsForSingleMsg": 0,
      "bilibili.forwardSendDynamic": 1, "bilibili.checkDynamicCD": "unrecognized" }, { Result })).toEqual({ ok: true })
    expect(await readFile(primary, "utf8")).toBe(original)
    const raw = await readFile(override, "utf8")
    expect(raw).toContain("# 非面板配置保留")
    expect(YAML.parse(raw)).toMatchObject({
      pushMsgMode: 0, mergeTextPic: 0, forwardSendDynamic: 1, maxPicsForSingleMsg: 0,
      checkDynamicCD: "*/23 * * * *", custom: { color: "teal" },
    })

    const fresh = supportGuoba(data).configInfo
    expect(await fresh.getConfigData()).toEqual({ bilibili: {
      pushMsgMode: 0, mergeTextPic: 0, forwardSendDynamic: 1, maxPicsForSingleMsg: 0, maxTextLengthForSingleMsg: 300,
    }, weibo: defaults })
    expect(useDynamicForward(nodes, await store.settings("bilibili"))).toBe(true)
    expect(await fresh.setConfigData({ "bilibili.maxPicsForSingleMsg": 1 }, { Result })).toEqual({ ok: true })
    expect(useDynamicForward(nodes, await store.settings("bilibili"))).toBe(false)
  } finally {
    await rm(data, { force: true, recursive: true })
  }
})

test("微博面板沿用旧覆盖文件并与 B 站独立保存", async () => {
  const data = await mkdtemp(join(tmpdir(), "lotus-weibo-guoba-"))
  try {
    const directory = join(data, "yuki-plugin", "config", "weibo")
    await mkdir(directory, { recursive: true })
    const primary = join(directory, "config.yaml")
    const override = join(directory, "config.guoba.support.yaml")
    const bilibili = join(data, "yuki-plugin", "config", "bilibili", "config.guoba.support.yaml")
    const original = "forwardSendDynamic: 1\npushMsgMode: 1\n"
    const previous = "# 微博旧面板设置\nforwardSendDynamic: 0\npushMsgMode: 0\nmergeTextPic: 0\nbanWords: [样例]\n"
    await writeFile(primary, original)
    await writeFile(override, previous)

    const { configInfo: form } = supportGuoba(data)
    expect(form.schemas.filter(({ field }) => field?.startsWith("weibo.")).map(({ field }) => field)).toEqual(
      Object.keys(defaults).map((key) => `weibo.${key}`),
    )
    expect(await form.getConfigData()).toEqual({ bilibili: defaults, weibo: {
      ...defaults, pushMsgMode: 0, mergeTextPic: 0, forwardSendDynamic: 0,
    } })
    expect(await form.setConfigData({ "bilibili.pushMsgMode": 0, "weibo.maxTextLengthForSingleMsg": 50001 }, { Result }))
      .toEqual({ ok: false, status: 422 })
    expect(existsSync(bilibili)).toBe(false)
    expect(await readFile(override, "utf8")).toBe(previous)

    expect(await form.setConfigData({ "weibo.forwardSendDynamic": "1", "weibo.maxTextLengthForSingleMsg": 3 }, { Result }))
      .toEqual({ ok: true })
    const raw = await readFile(override, "utf8")
    expect(raw).toContain("# 微博旧面板设置")
    expect(YAML.parse(raw)).toEqual({ ...YAML.parse(previous), forwardSendDynamic: 1, maxTextLengthForSingleMsg: 3 })
    expect(await readFile(primary, "utf8")).toBe(original)
    expect(existsSync(bilibili)).toBe(false)

    const store = createSubscriptionConfig(data, lockFile)
    const nodes = [{ payloads: ["四个字啦"] }]
    expect(useDynamicForward(nodes, await store.settings("weibo"))).toBe(true)
    expect(useDynamicForward(nodes, await store.settings("bilibili"))).toBe(false)
    expect(await form.setConfigData({ "bilibili.mergeTextPic": 0, "weibo.maxTextLengthForSingleMsg": 4 }, { Result }))
      .toEqual({ ok: true })
    expect(await form.getConfigData()).toEqual({ bilibili: { ...defaults, mergeTextPic: 0 }, weibo: {
      ...defaults, pushMsgMode: 0, mergeTextPic: 0, maxTextLengthForSingleMsg: 4,
    } })
    expect(useDynamicForward(nodes, await store.settings("weibo"))).toBe(false)
  } finally {
    await rm(data, { force: true, recursive: true })
  }
})
