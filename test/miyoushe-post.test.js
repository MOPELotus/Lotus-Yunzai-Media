import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sendCommandReply } from "../../../lib/commands.ts"
import { createMiyoushePostCommands } from "../services/official-video/post-command.ts"

test("米游社分享通过固定公开接口读同一帖，保留图文顺序及现用图片域", async () => {
  const requests = []
  const rendered = []
  const file = new Uint8Array([1, 2, 3])
  const image = "https://upload-bbs.miyoushe.com/test.png"
  const video = "https://prod-vod-sign.miyoushe.com/test.mp4"
  let id = "7890"
  const command = createMiyoushePostCommands({
    async request(url, options) {
      requests.push(url.href)
      expect(url.searchParams.get("read")).toBe("0")
      expect(options.headers.Referer).toBe("https://www.miyoushe.com/")
      return { retcode: 0, data: { post: { user: { nickname: "合成作者" }, post: {
        post_id: id, subject: "测试帖", cover: image, images: [image, "https://upload-bbs.miyoushe.com.example.test/bad.png"],
        structured_content: JSON.stringify([{ insert: "图前\n" }, { insert: { image } }, { insert: "图后\n" }]),
      }, vod_list: [{ resolutions: [{ url: "https://example.test/ignored.mp4" }, { url: video }] }] } } }
    },
    async render(template, { blocks }) { rendered.push([template, blocks]); return file },
  })
  const url = "https://www.miyoushe.com/sr/article/7890"
  const context = { message_type: "group", normalizedMessage: "分享：" + url }
  expect(command.features(context)).toEqual(["[media] 米游社帖子"])
  expect(await command.fallback(context.normalizedMessage, context)).toEqual({ type: "forward", nodes: [
    `测试帖\n合成作者\n${url}`, { type: "image", file }, [{ type: "image", file }, `原图：${image}`],
    { type: "image", file }, `视频地址：${video}`,
  ] })
  expect(rendered).toEqual([
    ["article", [{ type: "text", text: "图前" }]], ["article", [{ type: "image", urls: [image] }]],
    ["article", [{ type: "text", text: "图后" }]],
  ])
  expect(requests).toEqual(["https://bbs-api.mihoyo.com/post/wapi/getPostFull?post_id=7890&read=0"])
  expect(await command.fallback(url, { ...context, isDelegated: true })).toBeUndefined()
  expect(await command.fallback(url, { ...context, message_type: "terminal" })).toBeUndefined()
  expect(await command.fallback("https://outside.test/?url=" + url, context)).toBeUndefined()
  expect(await command.fallback("#播放 " + url, context)).toBeUndefined()
  expect(requests).toHaveLength(1)
  id = "7891"
  expect(await command.fallback(url, context)).toContain("没有返回匹配")
  expect(rendered).toHaveLength(3)
  id = "7890"
  expect(await command.fallback(url, { ...context, inlineImageByteLimit: 2 })).toEqual({ type: "forward", nodes: [
    `测试帖\n合成作者\n${url}`, "图前", image, "图后", `视频地址：${video}`,
  ] })
})

test("米游社视频仅在原会话确认收到预览后发一次，同号另一协议独立", async () => {
  const tasksDir = await mkdtemp(join(tmpdir(), "lotus-miyoushe-video-test-"))
  const video = "https://prod-vod-sign.miyoushe.com/sample.mp4"
  const postLink = "https://www.miyoushe.com/sr/article/7890"
  const transfers = []
  const sent = []
  const replies = []
  const bytes = Buffer.from("\0\0\0\x14ftypisomtest-contents")
  const command = createMiyoushePostCommands({ tasksDir,
    request: async () => ({ retcode: 0, data: { post: { post: { post_id: "7890", subject: "新视频" },
      vod_list: [{ resolutions: [{ url: video }] }] } } }),
    async fetchVideo(url, init) {
      transfers.push(url)
      expect(init.credentials).toBe("omit")
      expect(init.redirect).toBe("manual")
      expect(new Headers(init.headers).has("Cookie")).toBe(false)
      expect(new Headers(init.headers).has("Authorization")).toBe(false)
      return new Response(bytes)
    },
  })
  try {
    function context(adapter, messageId, connection, receipt = true) {
      return { adapter, message_type: "group", group_id: 77, user_id: 42, self_id: 999, message_id: messageId,
        groupActivitySignal: connection?.signal, forward: async () => receipt,
        reply: async message => { replies.push(message); return true },
        async deliverMedia(file) {
          expect(file.type).toBe("video")
          expect(file.name).toBe("新视频.mp4")
          expect(Buffer.from(await Bun.file(file.path).arrayBuffer())).toEqual(bytes)
          sent.push(adapter ?? "onebot")
          return adapter === "milky" ? "unknown" : "confirmed"
        },
      }
    }
    const onebot = context(undefined, 1)
    const fallback = ctx => command.fallback(postLink, ctx)
    const noReceipt = context(undefined, 2, undefined, false)
    await sendCommandReply(noReceipt, await fallback(noReceipt))
    expect(transfers).toEqual([])
    const initial = await fallback(onebot)
    expect(transfers).toEqual([])
    await sendCommandReply(onebot, initial)
    await initial.onDelivered()
    await sendCommandReply(onebot, await fallback(onebot))
    expect(sent).toEqual(["onebot"])
    const milky = context("milky", 1)
    await sendCommandReply(milky, await fallback(milky))
    await sendCommandReply(milky, await fallback(milky))
    expect(sent).toEqual(["onebot", "milky"])
    expect(replies.filter(message => typeof message === "string" && message.includes("送达未确认"))).toHaveLength(1)
    expect(replies.filter(message => typeof message === "object")).toEqual([])
    const ended = new AbortController()
    const disconnected = context(undefined, 3, ended)
    const stale = await fallback(disconnected)
    ended.abort()
    await sendCommandReply(disconnected, stale)
    expect(transfers).toEqual([video, video])
    expect(await readdir(tasksDir)).toEqual([])
  } finally {
    await command.dispose()
    await rm(tasksDir, { recursive: true, force: true })
  }
})

test("米游社视频拒绝 CDN 站外跳转并清理任务", async () => {
  const tasksDir = await mkdtemp(join(tmpdir(), "lotus-miyoushe-video-redirect-test-"))
  const video = "https://prod-vod-sign.miyoushe.com/sample.mp4"
  const transfers = []
  const results = []
  const command = createMiyoushePostCommands({ tasksDir,
    request: async () => ({ retcode: 0, data: { post: { post: { post_id: "7890", subject: "重定向" },
      vod_list: [{ resolutions: [{ url: video }] }] } } }),
    async fetchVideo(url) {
      transfers.push(url)
      return new Response(null, { status: 302, headers: { Location: "https://outside.example/video.mp4" } })
    },
  })
  try {
    const event = { message_type: "private", user_id: 42, self_id: 999, message_id: 1,
      forward: async () => true, deliverMedia: async () => { throw new Error("不应投递") },
      reply: async message => { results.push(message); return true },
    }
    await sendCommandReply(event, await command.fallback("https://www.miyoushe.com/sr/article/7890", event))
    expect(transfers).toEqual([video])
    expect(results).toEqual(["米游社视频发送失败，可打开上面的原帖或视频链接。"])
    expect(await readdir(tasksDir)).toEqual([])
  } finally {
    await command.dispose()
    await rm(tasksDir, { recursive: true, force: true })
  }
})

test("原会话断开会中止正在下载的米游社视频且不可重放", async () => {
  const tasksDir = await mkdtemp(join(tmpdir(), "lotus-miyoushe-video-stop-test-"))
  const started = Promise.withResolvers()
  const connection = new AbortController()
  const sent = []
  let fetches = 0
  const command = createMiyoushePostCommands({ tasksDir,
    request: async () => ({ retcode: 0, data: { post: { post: { post_id: "7890" },
      vod_list: [{ resolutions: [{ url: "https://prod-vod-sign.miyoushe.com/sample.mp4" }] }] } } }),
    async fetchVideo(_, { signal }) {
      fetches++
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        started.resolve()
      })
    },
  })
  try {
    const event = { message_type: "private", user_id: 42, self_id: 999, message_id: 1,
      privateCredentialSignal: connection.signal, forward: async () => true,
      deliverMedia: async file => { sent.push(file); return "confirmed" },
      reply: async message => { sent.push(message); return true },
    }
    const result = await command.fallback("https://www.miyoushe.com/sr/article/7890", event)
    const pending = sendCommandReply(event, result)
    await started.promise
    connection.abort()
    await pending
    await result.onDelivered()
    expect(sent).toEqual([])
    expect(fetches).toBe(1)
    expect(await readdir(tasksDir)).toEqual([])
  } finally {
    connection.abort()
    await command.dispose()
    await rm(tasksDir, { recursive: true, force: true })
  }
})
