import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { loadPublicShareConfig } from "../core/config/global.ts"
import { supportGuoba } from "../guoba-settings.ts"
import type { MessageFallbackContext } from "../../../lib/commands.ts"
import { createHeyboxPreview, parseHeyboxShare } from "../services/heybox/preview.ts"

const api = "https://api.xiaoheihe.cn/game/share_game_detail"
const publicUrl = api + "?appid=3649580&game_type=pc"
const source = publicUrl + "&h_src=dev#detail"
const landing = "https://www.xiaoheihe.cn/game/share_game_detail"
const titleRedirect = landing + "?appid=3649580&game_type=pc&title=" + encodeURIComponent("凛冬前线")
const context = (message: string, overrides: Partial<MessageFallbackContext> = {}) => ({
  normalizedMessage: message, message_type: "group", user_id: 1001, group_id: 1002, isMaster: false, ...overrides,
}) as MessageFallbackContext

test("小黑盒只识别无用户标题的官方 PC 游戏分享链接", () => {
  expect(parseHeyboxShare(source)).toEqual({ id: "3649580", link: source })
  for (const url of [
    publicUrl + "&title=伪造",
    publicUrl + "&%74itle=伪造",
    publicUrl + "&appid=3332060",
    publicUrl + "&game_type=pc",
    publicUrl.replace("=pc", "=mobile"),
    publicUrl.replace("=pc", "=console"),
    publicUrl.replace("api.xiaoheihe.cn", "api.xiaoheihe.cn.example.org"),
    publicUrl.replace("https", "http"),
    publicUrl.replace("/game/", "/nested/../game/"),
    publicUrl + "&h_src=" + "a".repeat(770),
    "https://www.xiaoheihe.cn/app/topic/game/pc/3649580",
    "https://www.xiaoheihe.cn/app/bbs/link/9912710d3192",
  ]) expect(parseHeyboxShare(url)).toBeUndefined()
})

test("小黑盒只请求一次匿名官方跳转并保留完整原链接", async () => {
  let calls = 0
  const preview = createHeyboxPreview({
    loadConfig: async () => ({ enable: true, privatePreview: false, permissions: {} }),
    fetch: async (url, options) => {
      calls++
      expect(url).toBe(publicUrl)
      expect(options).toMatchObject({ redirect: "manual", credentials: "omit" })
      expect(options?.headers).toBeUndefined()
      return new Response(null, { status: 302, headers: { location: titleRedirect } })
    },
    render: async (name, card) => {
      expect(name).toBe("bilibili-info")
      expect(card).toEqual({ title: "凛冬前线", type: "public-link", owner: "小黑盒", id: "PC 游戏", showStats: false })
      return Buffer.from("image")
    },
  })
  expect(preview.features(context(source))).toEqual(["[media] 小黑盒 PC 游戏预览"])
  expect(await preview.fallback(source, context(source))).toEqual([
    { type: "image", file: Buffer.from("image") }, { type: "text", text: source },
  ])
  expect(calls).toBe(1)
  const summary = "#总结一下 " + source
  expect(preview.features(context(summary))).toEqual([])
  expect(await preview.fallback(summary, context(summary))).toBeUndefined()
  expect(calls).toBe(1)
})

test("小黑盒拒绝模糊或冒用的跳转回包，保留可打开的原链接", async () => {
  for (const [status, location] of [
    [301, titleRedirect],
    [302, titleRedirect.replace("3649580", "3332060")],
    [302, titleRedirect.replace("=pc", "=console")],
    [302, titleRedirect.replace("www.xiaoheihe.cn", "evil.example")],
    [302, titleRedirect.replace("www.xiaoheihe.cn", "www.xiaoheihe.cn.example")],
    [302, titleRedirect.replace("/game/share_game_detail", "/app/bbs/link/3649580")],
    [302, titleRedirect + "&title=伪造"],
    [302, titleRedirect + "&appid=3649580"],
    [302, titleRedirect + "%0A伪造"],
    [302, titleRedirect + "%E2%80%AE"],
    [302, titleRedirect + "a".repeat(121)],
    [302, titleRedirect + "%5BCQ%3Aat%2Cqq%3Dall%5D"],
  ] as const) {
    let calls = 0
    const preview = createHeyboxPreview({
      loadConfig: async () => ({ enable: true, privatePreview: false, permissions: {} }),
      fetch: async () => {
        calls++
        return new Response(null, { status, headers: { location } })
      },
      render: async () => { throw new Error("unexpected render") },
    })
    expect(await preview.fallback(source, context(source))).toBe("暂无法读取小黑盒游戏名称。\n" + source)
    expect(calls).toBe(1)
  }
})

test("小黑盒停用、私聊关闭与权限拒绝均无出站", async () => {
  let calls = 0
  const blocked = [
    { config: { enable: false, privatePreview: false, permissions: {} } },
    { config: { enable: true, privatePreview: false, permissions: {} },
      event: { message_type: "private", privateCredentialSignal: new AbortController().signal } },
    { config: { enable: true, privatePreview: false, permissions: { scopes: { "xhh.preview": { policy: "deny" } } } } },
  ] as const
  for (const row of blocked) {
    const preview = createHeyboxPreview({
      loadConfig: async () => row.config,
      fetch: async () => { calls++; return new Response() },
    })
    expect(await preview.fallback(source, context(source, "event" in row ? row.event : undefined))).toBeUndefined()
  }
  expect(calls).toBe(0)
})

test("小黑盒公开预览沿用旧禁用及私聊开关，可在面板按来源覆写", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lotus-xhh-preview-"))
  try {
    const root = pathToFileURL(temp + "/")
    const oldSettings = join(temp, "backup/plugins/rconsole-plugin/config")
    await mkdir(oldSettings, { recursive: true })
    await writeFile(join(oldSettings, "tools.yaml"), "globalBlackList: [小黑盒]\nprivateResolve: true\n")
    const { configInfo } = supportGuoba(join(temp, "data"), undefined, root)
    expect(await configInfo.getConfigData()).toMatchObject({ xhh: { enable: false, private_preview: true } })
    expect(await configInfo.setConfigData({ "xhh.enable": true, "xhh.private_preview": false },
      { Result: { ok: () => 200, error: (_: string, status: number) => status } })).toBe(200)
    expect(await loadPublicShareConfig("xhh", root)).toMatchObject({ enable: true, privatePreview: false })
  } finally { await rm(temp, { recursive: true, force: true }) }
})
