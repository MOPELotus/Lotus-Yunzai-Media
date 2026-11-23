import { expect, test } from "bun:test"
import type { MessageFallbackContext } from "../../../lib/commands.ts"
import type { loadGlobalConfig } from "../core/config/global.ts"
import { createJikeCommands, parseJikePost } from "../services/jike/command.ts"

const id = "63c0cee35b351a0c14540914"
const source = `https://m.okjike.com/originalPosts/${id}`
const images = Array.from({ length: 5 }, (_, i) => `https://cdnv2.ruguoapp.com/${i}.jpg`)
const post = { id, type: "ORIGINAL_POST", status: "NORMAL", content: "公开文字", user: { screenName: "作者" },
  pictures: images.map(picUrl => ({ picUrl })) }
const html = (value: unknown) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { post: value } } })}</script>`
const config = (async () => ({ tools: {}, permissions: {} })) as typeof loadGlobalConfig

test("即刻同帖的原图按序发送，视频仅预览且毫秒正确转秒", async () => {
  expect(parseJikePost(html({ ...post, status: "DELETED" }), id)).toBeUndefined()
  expect(parseJikePost(html({ ...post, id: "different" }), id)).toBeUndefined()
  expect(parseJikePost(html({ ...post, pictures: [], video: { duration: 299866, image: { picUrl: images[0] } } }), id))
    .toMatchObject({ duration: 300, videoCover: images[0], hasVideo: true })
  const seen: string[] = []
  const png = Buffer.from([137,80,78,71,13,10,26,10])
  const command = createJikeCommands({ loadConfig: config, render: async () => Buffer.from([1]),
    fetch: async (url, init) => {
      seen.push(url)
      expect(init?.credentials).toBe("omit")
      if (url === source) return new Response(html(post))
      if (images.includes(url)) return new Response(Buffer.concat([png, Buffer.from([images.indexOf(url)])]))
      throw new Error(url)
    },
  })
  const context = { normalizedMessage: source, message_type: "group", isMaster: false, isBotMaster: () => false, group_id: 1, reply: () => true } as MessageFallbackContext
  expect(command.features(context)).toEqual(["[media] 即刻解析"])
  expect(await command.fallback(source, { ...context, message_type: "private" })).toBeUndefined()
  const result = await command.fallback(source, context)
  expect(result).toMatchObject({ type: "forward", nodes: [
    [{ type: "image", file: Buffer.from([1]) }, `即刻\n作者：作者\n${source}`],
    ...images.map((_, i) => ({ type: "image", file: Buffer.concat([png, Buffer.from([i])]) })),
  ] })
  expect(seen).toEqual([source, ...images])
})
