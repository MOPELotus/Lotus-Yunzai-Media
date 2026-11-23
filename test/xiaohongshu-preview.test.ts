import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { CommandRegistry } from "../../../lib/commands.ts"
import { lockFile } from "../../../lib/file-lock.ts"
import type { MessageEvent } from "../../../lib/messages.ts"
import { loadPublicShareConfig } from "../core/config/global.ts"
import { supportGuoba } from "../guoba-settings.ts"
import { createModule } from "../index.ts"
import { parseXiaohongshuPage } from "../services/xiaohongshu/preview.ts"

const id = "69b8e8c6000000001a0253b5"
const canonical = "https://www.xiaohongshu.com/explore/" + id
const sharedNote = `https://www.xiaohongshu.com/discovery/item/${id}?xsec_token=fixture%2B%3D&xsec_source=app_share&track_code=fixture`
const short = "https://xhslink.cn/o/3VW23QbDtvK"
const cover = "https://sns-webpic-qc.xhscdn.com/20260101/aabb/note_pre_post_uhdr/examplephoto123456!thumb"
const page = (changes: Record<string, unknown> = {}, source = canonical) =>
  `<head><link rel="canonical" href="${source}"><meta property="og:url" content="${source}">
    <meta property="og:image" content="https://evil.example/placeholder.png"></head><body>
    <script>window.__INITIAL_STATE__={"other":undefined,"note":{"noteDetailMap":{"${id}":{"currentTime":79,"note":${JSON.stringify({
      noteId: id, type: "normal", title: "", desc: "公开的开头\n同笔记 undefined 文案",
      user: { nickname: "公开作者" }, imageList: [{ fileId: "note_pre_post_uhdr/examplephoto123456", urlDefault: cover }], ...changes,
    })}}}}};</script></body>`
const event = (msg: string, changes: Partial<MessageEvent> = {}): MessageEvent => ({
  msg, raw_message: msg, message: [], message_type: "group", post_type: "message", isGroup: true, isPrivate: false,
  user_id: 9001, group_id: 2000, self_id: 8000, isMaster: false, async reply() { return true }, ...changes,
})

test("小红书响应以 canonical、og:url、状态键与 noteId 核同一笔记及首图", () => {
  expect(parseXiaohongshuPage(page(), id)).toEqual({
    title: "公开的开头", owner: "公开作者", desc: "同笔记 undefined 文案", cover: new URL(cover),
  })
  expect(parseXiaohongshuPage(page({ noteId: "0".repeat(24) }), id)).toBeUndefined()
  expect(parseXiaohongshuPage(page({}, canonical.replace(id, "0".repeat(24))), id)).toBeUndefined()
  expect(parseXiaohongshuPage("<head><title>登录</title></head>", id)).toBeUndefined()
  expect(parseXiaohongshuPage(page().replace('{"other":undefined', '{alert("test"),"other":null'), id)).toBeUndefined()
  expect(parseXiaohongshuPage(page({ imageList: [{ fileId: "unboundotherimage123", urlDefault: cover }] }), id)?.cover).toBeUndefined()
  expect(parseXiaohongshuPage(page({ desc: "一".repeat(150) }), id)?.desc).toBe("一".repeat(10))
})

test("Media 小红书只访问官方同号页面、用原样公开参数并拒绝登录、错号与跨站重定向", async () => {
  const controller = new AbortController()
  let loaded = { enable: true, privatePreview: false, permissions: {} as unknown }
  const calls: string[] = []
  let redirect = sharedNote
  let noteRedirect: string | undefined
  const module = await createModule({ lockFile, signal: controller.signal, xiaohongshu: {
    loadConfig: async site => { expect(site).toBe("xhs"); return loaded },
    async fetch(url, init) {
      expect(init?.credentials).toBe("omit")
      calls.push(url)
      if (url === short) return Response.redirect(redirect)
      if (url === sharedNote) return noteRedirect ? Response.redirect(noteRedirect) : new Response(page(), { headers: { "Content-Type": "text/html" } })
      expect(url).toBe(cover)
      expect(init?.redirect).toBe("error")
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } })
    },
    async render(template, card) {
      expect(template).toBe("bilibili-info")
      expect(card).toMatchObject({ title: "公开的开头", owner: "公开作者", desc: "同笔记 undefined 文案", cover: Buffer.from([1, 2, 3]) })
      return Buffer.from("fixture")
    },
  } })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "@lotus-yunzai/media", ...module })
  const dispatch = (msg: MessageEvent, disabled = false) => registry.dispatchFallback(msg,
    names => !disabled || !names.includes("[media] 小红书公开预览"), () => false)
  try {
    expect(await dispatch(event(short), true)).toBeUndefined()
    expect(await dispatch(event(short, { message_type: "private", isGroup: false, isPrivate: true, privateCredentialSignal: controller.signal }))).toBeUndefined()
    loaded = { ...loaded, permissions: { scopes: { "xhs.preview": { policy: "deny" } } } }
    expect(await dispatch(event(short))).toBeUndefined()
    expect(calls).toEqual([])
    loaded = { ...loaded, permissions: {} }
    const image = { type: "image", file: Buffer.from("fixture") } as const
    expect(await dispatch(event(short))).toEqual([image, { type: "text", text: short }])
    expect(await dispatch(event(sharedNote))).toEqual([image, { type: "text", text: sharedNote }])
    expect(calls.splice(0)).toEqual([short, sharedNote, cover, sharedNote, cover])
    for (const rejected of ["https://www.xiaohongshu.com/login", "https://www.xiaohongshu.com/404", "https://evil.example/" + id]) {
      redirect = rejected
      expect(await dispatch(event(short))).toContain(short)
      expect(calls.splice(0)).toEqual([short])
    }
    noteRedirect = canonical.replace(id, "0".repeat(24))
    expect(await dispatch(event(sharedNote))).toContain(sharedNote)
    expect(calls.splice(0)).toEqual([sharedNote])
  } finally { controller.abort(); await module.dispose() }
})

test("小红书面板继承旧小红书禁用及私聊开关，可按来源落盘覆写", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lotus-xhs-preview-"))
  try {
    const root = pathToFileURL(temp + "/")
    const old = join(temp, "backup/plugins/rconsole-plugin/config")
    await mkdir(old, { recursive: true })
    await writeFile(join(old, "tools.yaml"), "globalBlackList: [小红书]\nprivateResolve: true\n")
    const { configInfo } = supportGuoba(join(temp, "data"), undefined, root)
    expect(await configInfo.getConfigData()).toMatchObject({ xhs: { enable: false, private_preview: true } })
    expect(await configInfo.setConfigData({ "xhs.enable": true, "xhs.private_preview": false },
      { Result: { ok: () => 200, error: (_: string, status: number) => status } })).toBe(200)
    expect(await loadPublicShareConfig("xhs", root)).toMatchObject({ enable: true, privatePreview: false })
  } finally { await rm(temp, { recursive: true, force: true }) }
})
