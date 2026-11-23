import { expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { MessageFallbackContext } from "../../../lib/commands.ts"
import { createPipixiaCommands } from "../services/pipixia/command.ts"
import type { loadGlobalConfig } from "../core/config/global.ts"

const id = "7641086036809881866"
const preview = "https://h5.pipix.com/s/publicshare/"
const article = `https://h5.pipix.com/ppx/item/${id}`
const source = "https://v26-cdn-tos.ppxvod.com/a.mp4"
const cover = "https://p9-ppx-sign.byteimg.com/a.jpg"
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from("ftypisomtest")])
const fixture = {
  ppxItemDetail: { item: { item_id_str: id, status: 0, content: "测试短视频", author: { name: "样本作者" },
    cover: { url_list: [{ url: cover }] }, duration: 8.87, create_time: 1_770_000_000, can_download: true,
    video: { video_download: { url_list: [{ url: "http://localhost:9000/a.mp4" }, { url: source }] } },
    stats: { like_count: 5, comment_count: 2, share_count: 1, play_count: 11 },
  } },
  ppxCellComment: { cell_comments: [
    { comment_info: { text: "公开评论", user: { name: "评论账号" }, like_count: 3, reply_count: 1,
      item: { video: { video_high: { url_list: [{ url: "https://v26-cdn-tos.ppxvod.com/wrong.mp4" }] } } } } },
  ] },
}
const html = (body: unknown) => new Response(`<script id="RENDER_DATA" type="application/json">${encodeURIComponent(JSON.stringify(body))}</script>`)
const loadConfig = (tools = {}, permissions = {}) => (async () => ({ tools, permissions })) as typeof loadGlobalConfig

function context(message = preview, rest = {}) {
  return {
    normalizedMessage: message, message_type: "group", group_id: 567, user_id: 123, reply: () => true,
    isMaster: false, isBotMaster: () => false, ...rest,
  } as MessageFallbackContext
}

test("皮皮虾短链只访问原站、出封面统计卡并在回执后发送同帖视频和评论", async () => {
  const dir = await mkdtemp("/tmp/lotus-ppx-task-test-")
  const seen: string[] = []
  const delivered: unknown[] = []
  const commands = createPipixiaCommands({ tasksDir: dir, loadConfig: loadConfig(),
    fetch: async (url, init) => {
      seen.push(url)
      expect(init?.credentials).toBe("omit")
      expect(init?.redirect).toBe("manual")
      if (url === preview) return Response.redirect(article)
      if (url === article) return html(fixture)
      if (url === source) return new Response(mp4)
      throw new Error(url)
    },
    render: async (template, card) => {
      expect(template).toBe("pipixia-info")
      expect(card).toMatchObject({ title: "测试短视频", owner: "样本作者", cover,
        stat: { like: 5, reply: 2, share: 1, view: 11 } })
      return Buffer.from([7])
    },
  })
  try {
    const event = context(preview, {
      deliverMedia: async ({ path, type }: { path: string; type: string }) => {
        delivered.push(type, await readFile(path))
        return "confirmed"
      },
      forward: async (nodes: readonly string[]) => { delivered.push(nodes); return true },
    })
    expect(commands.features(event)).toEqual(["[media] 皮皮虾解析"])
    const reply = await commands.fallback(preview, event)
    expect(seen).toEqual([preview, article])
    expect(reply).toMatchObject({ type: "delivery", message: [{ type: "image", file: Buffer.from([7]) }, article] })
    if (!reply || typeof reply !== "object" || !("onDelivered" in reply) || reply.type !== "delivery") throw new Error("missing delivery")
    await reply.onDelivered(12)
    await reply.onDelivered(13)
    expect(seen).toEqual([preview, article, source])
    expect(delivered).toEqual(["video", mp4, ["评论账号\n公开评论\n点赞 3 · 回复 1"]])
    expect(await readdir(dir)).toEqual([])
  } finally {
    await commands.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test("皮皮虾阻止跨域跳转、禁止私聊默认解析并识别缺少身份匹配的公开页", async () => {
  const seen: string[] = []
  const commands = createPipixiaCommands({ loadConfig: loadConfig(),
    fetch: async url => {
      seen.push(url)
      return url === preview ? Response.redirect("https://evil.test/item/123") : html(fixture)
    },
    render: async () => { throw new Error("render skipped") },
  })
  try {
    expect(commands.features(context("https://h5.pipix.com.evil.test/s/test/"))).toEqual([])
    expect(await commands.fallback(preview, context(preview, { message_type: "private" }))).toBeUndefined()
    expect(seen).toEqual([])
    expect(await commands.fallback(preview, context())).toContain("未返回")
    expect(await commands.fallback("https://h5.pipix.com/item/123", context())).toContain("未返回")
    expect(seen).toEqual([preview, "https://h5.pipix.com/item/123"])
  } finally { await commands.dispose() }
})

test("锅巴写入与群、私聊解析共用存储，并继承旧通用开关", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises")
  const { createPipixiaSettings } = await import("../services/pipixia/settings.ts")
  const { supportGuoba } = await import("../guoba-settings.ts")
  const root = await mkdtemp("/tmp/lotus-ppx-guoba-")
  const data = join(root, "data")
  const legacy = join(root, "backup/plugins/rconsole-plugin/config")
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, "tools.yaml"), 'privateResolve: true\nglobalBlackList: ["通用（包含快手等）"]\n')
  const settings = createPipixiaSettings(data, root)
  const tools = loadConfig()
  const guoba = supportGuoba(data, undefined, undefined, settings, tools).configInfo
  const Result = { ok: () => 200, error: (_: string, status: number) => status }
  const requests: string[] = []
  const commands = createPipixiaCommands({ settings, loadConfig: tools,
    fetch: async url => { requests.push(url); return html({}) },
    render: async () => Buffer.from([1]),
  })
  try {
    expect(await guoba.getConfigData()).toMatchObject({ pipixia: { enable: false, private: true } })
    expect(await commands.fallback(article, context(article))).toBeUndefined()
    expect(await commands.fallback(article, context(article, { message_type: "private" }))).toBeUndefined()
    expect(requests).toHaveLength(0)
    expect(await guoba.setConfigData({ "pipixia.enable": "false" }, { Result })).toBe(422)
    expect(await guoba.setConfigData({ "pipixia.enable": true, "pipixia.private": false },
      { Result, changedFields: ["pipixia.enable"] })).toBe(200)
    expect(await commands.fallback(article, context(article))).toContain("未返回")
    expect(await commands.fallback(article, context(article, { message_type: "private" }))).toContain("未返回")
    expect(await guoba.setConfigData({ "pipixia.private": false }, { Result })).toBe(200)
    expect(await commands.fallback(article, context(article, { message_type: "private" }))).toBeUndefined()
    expect(requests).toEqual([article, article])
    expect(await guoba.getConfigData()).toMatchObject({ pipixia: { enable: true, private: false } })
  } finally {
    await commands.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("皮皮虾未知网关回执不重新上传，也不回退至逐字节重发", async () => {
  const dir = await mkdtemp("/tmp/lotus-ppx-unknown-")
  const messages: unknown[] = []
  let downloads = 0, uploads = 0
  const commands = createPipixiaCommands({ tasksDir: dir, loadConfig: loadConfig(),
    fetch: async url => {
      if (url === article) return html(fixture)
      if (url === source) { downloads++; return new Response(mp4) }
      throw new Error(url)
    },
    render: async () => Buffer.from([1]),
  })
  try {
    const event = context(article, {
      deliverMedia: () => { uploads++; return "unknown" },
      reply: (message: unknown) => { messages.push(message); return true },
    })
    const result = await commands.fallback(article, event)
    if (!result || typeof result !== "object" || !("onDelivered" in result) || result.type !== "delivery") throw new Error("missing delivery")
    await result.onDelivered(12)
    await result.onDelivered(12)
    expect(downloads).toBe(1)
    expect(uploads).toBe(1)
    expect(messages).toEqual(["视频送达未确认，请核对当前会话。"])
    expect(await readdir(dir)).toEqual([])
  } finally {
    await commands.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
