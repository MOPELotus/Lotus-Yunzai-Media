import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { CommandRegistry } from "../../../lib/commands.ts"
import { lockFile } from "../../../lib/file-lock.ts"
import type { MessageEvent } from "../../../lib/messages.ts"
import { loadGlobalConfig } from "../core/config/global.ts"
import { supportGuoba } from "../guoba-settings.ts"
import { createModule } from "../index.ts"
import { parseXiguaPage, parseXiguaShare } from "../services/xigua/preview.ts"
import { createPublicShareSettings } from "../services/public-share/settings.ts"

const id = "6870484788273218055"
const mobile = "https://m.ixigua.com/video/" + id
const desktop = "https://www.ixigua.com/" + id
const short = "https://v.ixigua.com/abcdef/"
const cover = "https://p26-sign.douyinpic.com/tos-cn-p-0000/cover~tplv-noop.image?sign=test"
const body = (changes: Record<string, unknown> = {}, url = mobile) =>
  `<head><link rel="canonical" href="${url}"><script type="application/ld+json">${JSON.stringify({
    "@type": "VideoObject", name: "同作品 | 西瓜视频", author: { name: "同一作者" }, duration: "PT35.072S",
    embedUrl: mobile, thumbnailUrl: [cover], uploadDate: "2020-09-09T13:49:55.000Z",
    interactionStatistic: { userInteractionCount: 42 }, contentUrl: "https://example.invalid/no-media", ...changes,
  })}</script></head>`
const event = (msg: string, changes: Partial<MessageEvent> = {}): MessageEvent => ({
  msg, raw_message: msg, message: [], message_type: "group", post_type: "message", isGroup: true, isPrivate: false,
  user_id: 9001, group_id: 2000, self_id: 8000, isMaster: false, async reply() { return true }, ...changes,
})

test("西瓜分享只识别正式地址并核 canonical、同作品 VideoObject、作者和封面", () => {
  expect(parseXiguaShare(desktop + "?source=share")).toEqual({ id, link: mobile })
  expect(parseXiguaShare(short)).toEqual({ link: short })
  for (const value of ["https://www.ixigua.com", "https://m.ixigua.com/dx/" + id,
    "https://m.ixigua.com@evil.example/video/" + id, "https://m.ixigua.com:8443/video/" + id]) expect(parseXiguaShare(value)).toBeUndefined()
  expect(parseXiguaPage(body(), id)).toMatchObject({ title: "同作品", owner: "同一作者", cover: new URL(cover),
    duration: 35.072, createdAt: Date.parse("2020-09-09T13:49:55.000Z") / 1000, view: 42 })
  expect(parseXiguaPage(body({ embedUrl: mobile.replace(id, "6870484788273218056") }), id)).toBeUndefined()
  expect(parseXiguaPage(body({}, mobile.replace(id, "6870484788273218056")), id)).toBeUndefined()
  expect(parseXiguaPage("<html><title>官网</title></html>", id)).toBeUndefined()
  expect(parseXiguaPage(body({ thumbnailUrl: ["https://p26-sign.douyinpic.com.evil.example/tos-cn-p-0000/test"] }), id)?.cover).toBeUndefined()
})

test("Media 西瓜群聊、私聊与逐群权限，旧短链只接受官方同号目标且不取视频", async () => {
  const controller = new AbortController()
  const cfg = await loadGlobalConfig(pathToFileURL(tmpdir() + "/"))
  const calls: string[] = []
  let enabled = true, privatePreview = false, forbidden = false, location = desktop
  const module = await createModule({ lockFile, signal: controller.signal, xigua: {
    settings: { settings: async () => ({ enable: enabled, private: privatePreview }) },
    loadConfig: async () => ({ ...cfg, permissions: { ...cfg.permissions,
      ...(forbidden && { scopes: { ...cfg.permissions.scopes, "xigua.preview": { policy: "deny" } } }) } }),
    fetch: async (url, options) => {
      calls.push(url)
      expect(options?.credentials).toBe("omit")
      if (url === short) return Response.redirect(location)
      if (url === mobile) return new Response(body(), { headers: { "Content-Type": "text/html" } })
      expect(url).toBe(cover)
      expect(options?.redirect).toBe("error")
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } })
    },
    async render(name, card) {
      expect(name).toBe("bilibili-info")
      expect(card).toMatchObject({ id: "西瓜视频 · " + id, title: "同作品", owner: "同一作者", cover: Buffer.from([1, 2, 3]) })
      return Buffer.from("fixture")
    },
  } })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "@lotus-yunzai/media", ...module })
  const dispatch = (input: MessageEvent, disabled = false) =>
    registry.dispatchFallback(input, names => !disabled || !names.includes("[media] 西瓜视频解析"), () => false)
  const privateMessage = event(mobile, { message_type: "private", isGroup: false, isPrivate: true,
    privateCredentialSignal: controller.signal })
  const result = [{ type: "image", file: Buffer.from("fixture") }, { type: "text", text: mobile }] as const
  try {
    expect(await dispatch(event(desktop), true)).toBeUndefined()
    expect(await dispatch(privateMessage)).toBeUndefined()
    expect(await dispatch(event("#播放 " + mobile))).toBeUndefined()
    enabled = false
    expect(await dispatch(event(short))).toBeUndefined()
    enabled = true
    forbidden = true
    expect(await dispatch(event(short))).toBeUndefined()
    expect(calls).toEqual([])
    forbidden = false
    expect(await dispatch(event(desktop))).toEqual(result)
    expect(await dispatch(event(short))).toEqual(result)
    privatePreview = true
    expect(await dispatch(privateMessage)).toEqual(result)
    expect(calls.splice(0)).toEqual([mobile, cover, short, mobile, cover, mobile, cover])
    for (const next of ["https://www.ixigua.com/", "https://evil.example/" + id]) {
      location = next
      expect(await dispatch(event(short))).toContain(short)
      expect(calls.splice(0)).toEqual([short])
    }
  } finally { controller.abort(); await module.dispose() }
})

test("面板独立存西瓜总开关和私聊开关，缺项沿用旧通用黑名单", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-xigua-"))
  try {
    const data = join(root, "data")
    const legacy = join(root, "backup/plugins/rconsole-plugin/config")
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, "tools.yaml"), "globalBlackList: [通用（包含快手等）]\nprivateResolve: true\n")
    const { configInfo } = supportGuoba(data, undefined, pathToFileURL(root + "/"))
    expect(await configInfo.getConfigData()).toMatchObject({ xigua: { enable: false, private: true } })
    const ctx = { Result: { ok: () => 200, error: (_: string, status: number) => status } }
    expect(await configInfo.setConfigData({ "xigua.enable": true, "xigua.private": "no" }, ctx)).toBe(422)
    expect(await configInfo.setConfigData({ "xigua.enable": true, "xigua.private": false }, ctx)).toBe(200)
    expect(await createPublicShareSettings("xigua", "西瓜视频", data, root).settings()).toEqual({ enable: true, private: false })
  } finally { await rm(root, { recursive: true, force: true }) }
})
