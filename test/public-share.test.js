import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadMedia } from "../services/media/download.ts"
import { fetchCdn } from "../services/media/cdn.ts"
import { createPublicShareCommands } from "../services/public-share/command.ts"
import { parsePublicShare, readPublicShare } from "../services/public-share/source.ts"

const weishiShort = "https://video.weishi.qq.com/q260xgqq"
const feedId = "7YaXkbaPB1WtR4KeU"
const weishiPage = `https://isee.weishi.qq.com/ws/app-pages/share/index.html?wxplay=1&id=${feedId}`
const zuiyouPage = "https://share.xiaochuankeji.cn/hybrid/share/post?pid=340830632"
const feed = { id: feedId, feedDesc: "微视样本", poster: { nick: "样本作者" }, videoCover: "https://xp.qpic.cn/c.jpg",
  video: { duration: 4000 }, videoUrl: "http://v.weishi.qq.com/example.mp4", createTime: 1_750_000_000 }
const post = { id: 340830632, privateStatus: 0, content: "最右样本", member: { name: "最右作者" }, ct: 1_750_000_000,
  imgs: [
    { id: 22, urls: { "540": { urls: ["http://web-f01.izuiyou.com/img/view/id/22"] } } },
    { id: 41, video: 1, urls: { "540": { urls: ["http://web-f01.izuiyou.com/img/frame/id/41"] } } },
    { id: 23, urls: { "540": { urls: ["http://web-f01.izuiyou.com/img/view/id/23"] } } },
  ], videos: { 41: { url: "http://web-v01.izuiyou.com/valid.mp4", dur: 15 },
    54: { url: "http://web-v01.izuiyou.com/unrelated.mp4", dur: 17 } } }
const png = Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3])
const mp4 = Buffer.from("\0\0\0 ftypisomtest")
const weishiHtml = (rows = [feed]) => `<script>try { window.Vise.initState = ${JSON.stringify({ feedsList: rows })}; } catch { }</script>`
const zuiyouHtml = (value = post) => `<script id="appState">window.APP_INITIAL_STATE=${JSON.stringify({
  sharePost: { postDetail: value && { post: value }, recommendPosts: { list: [post] } },
})}</script>`

test("微视官方短链只认同源作品，最右拒绝推荐和非公开目标", async () => {
  const signal = new AbortController().signal
  const target = parsePublicShare(weishiShort)
  let count = 0
  const media = await readPublicShare(target, signal, async (url, options) => {
    expect(options).toMatchObject({ redirect: "manual", credentials: "omit" })
    if (count++ === 0) {
      expect(url).toBe(weishiShort)
      return Response.redirect(weishiPage + "&spid=tracking")
    }
    expect(url).toBe(weishiPage)
    return new Response(weishiHtml())
  })
  expect(media).toMatchObject({ id: feedId, title: "微视样本", owner: "样本作者", cover: "https://xp.qpic.cn/c.jpg", duration: 4 })
  expect(media.video.href).toBe("https://v.weishi.qq.com/example.mp4")
  const never = async () => Response.redirect("https://untrusted.example/video")
  expect(await readPublicShare(target, signal, never)).toBeUndefined()
  expect(await readPublicShare(parsePublicShare(weishiPage), signal, async () => new Response(weishiHtml([{ ...feed, id: "another1234" }])))).toBeUndefined()
  for (const value of [undefined, { ...post, id: 1 }, { ...post, privateStatus: 1 }]) {
    const html = value ? zuiyouHtml(value) : zuiyouHtml(null)
    expect(await readPublicShare(parsePublicShare(zuiyouPage), signal, async () => new Response(html))).toBeUndefined()
  }
  for (const url of [weishiShort + "#x", zuiyouPage + "&pid=1", "https://video.weishi.qq.com.evil/aabbcc",
    "https://video.weishi.qq.com:1234/example", "https://share.xiaochuankeji.cn/hybrid/share/profile?pid=340830632"]) {
    expect(parsePublicShare(url)).toBeUndefined()
  }
})

test("最右预览仅发送本帖图像，显式命令下载一次同一作品的官方 MP4", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-public-share-"))
  const renders = [], direct = [], upstream = []
  const session = new AbortController()
  const module = createPublicShareCommands({ tasksDir: directory, async render(template, card) {
    renders.push([template, card])
    return png
  }, async fetchPage(url, options) {
    expect(url).toBe(zuiyouPage)
    expect(options.credentials).toBe("omit")
    return new Response(zuiyouHtml())
  }, async fetchMedia(url, options) {
    upstream.push(url)
    expect(options.credentials).toBe("omit")
    return new Response(url.endsWith(".mp4") ? mp4 : png)
  } })
  const context = { normalizedMessage: zuiyouPage, raw_message: zuiyouPage, message_type: "group", message_id: 23,
    self_id: 99, group_id: 8, user_id: 42, groupActivitySignal: session.signal,
    isMaster: false, isBotMaster: () => false, reply(message) { direct.push(message); return true } }
  try {
    expect(module.features(context)).toEqual(["[media] 最右分享"])
    const preview = await module.fallback(zuiyouPage, context)
    expect(preview).toMatchObject({ type: "forward", nodes: [[{ type: "image" }, expect.stringContaining("最右作者")],
      { type: "image" }, { type: "image" }] })
    expect(renders[0]).toMatchObject(["bilibili-info", { title: "最右样本", duration: 15, cover: "https://web-f01.izuiyou.com/img/frame/id/41" }])
    expect(upstream).toEqual(["https://web-f01.izuiyou.com/img/view/id/22", "https://web-f01.izuiyou.com/img/view/id/23"])
    const play = "#播放 " + zuiyouPage
    expect(await module.fallback(play, { ...context, isDelegated: true })).toBeUndefined()
    expect(await module.fallback(play, { ...context, groupActivitySignal: undefined })).toContain("当前绑定")
    expect(await module.fallback(play, context)).toEqual([])
    expect(await module.fallback(play, context)).toEqual([])
    expect(upstream).toHaveLength(3)
    expect(upstream.at(-1)).toBe("https://web-v01.izuiyou.com/valid.mp4")
    expect(direct).toMatchObject([{ type: "video", data: { name: "最右样本.mp4" } }])
    expect(await readdir(directory)).toEqual([])
    session.abort()
    expect(await module.fallback(zuiyouPage, context)).toBeUndefined()
  } finally {
    await module.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test("公开分享的媒体重定向不能跳到其他平台", async () => {
  await expect(fetchCdn(async () => Response.redirect("https://www.bilibili.com/stream.mp4"),
    "https://web-v01.izuiyou.com/valid.mp4", {}, "zuiyou-video")).rejects.toThrow("不属于分享来源")
})


test("公开视频不能把合法 MP4 文件头的非完整 Range 当作可发送文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-public-share-partial-"))
  try {
    await expect(downloadMedia("https://web-v01.izuiyou.com/valid.mp4", join(directory, "video"), {
      kind: "video", cdn: "zuiyou-video", fetch: async () => new Response(mp4, {
        status: 206, headers: { "Content-Range": `bytes 0-${mp4.length - 1}/999` },
      }),
    })).rejects.toThrow("媒体下载失败 HTTP 206")
    expect(await readdir(directory)).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
