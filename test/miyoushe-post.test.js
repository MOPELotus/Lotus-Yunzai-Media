import { expect, test } from "bun:test"
import { createMiyoushePostCommands } from "../services/official-video/post-command.ts"

test("米游社分享通过固定公开接口读同一帖，保留图文顺序及现用图片域", async () => {
  const requests = []
  const rendered = []
  const file = new Uint8Array([1, 2, 3])
  const image = "https://upload-bbs.miyoushe.com/test.png"
  const video = "https://vod.miyoushe.com/test.mp4"
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
