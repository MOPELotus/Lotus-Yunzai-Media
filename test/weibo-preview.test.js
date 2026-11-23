import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { lockFile } from "../../../lib/file-lock.ts"
import { createSubscriptionModule } from "../services/subscriptions/module.ts"
import { fetchPublicWeiboComments, fetchPublicWeiboPost } from "../services/subscriptions/weibo/index.ts"
import { createWeiboPreview } from "../services/subscriptions/weibo/preview.ts"
import { settingsFor } from "../services/subscriptions/config.ts"

const id = "4876543210123456", uid = "2656274875", bid = "mA1Bc23d"
const url = `https://weibo.com/${uid}/${bid}`
const post = { idstr: id, bid, created_at: "Thu Nov 19 09:20:00 +0800 2026",
  user: { idstr: uid, screen_name: "样本作者" }, text: "样本动态<br>第二行", pics: [{ url: "https://wx1.sinaimg.cn/example.jpg" }] }
const html = value => new Response(`<script>var $render_data=[{"status":${JSON.stringify(value)},"call":"ok"}][0]</script>`)

test("微博公开详情只访问官网匿名接口，并核对标题链接的正文和作者", async () => {
  const requests = []
  const fetch = async (endpoint, { signal, ...options }) => {
    requests.push({ endpoint: endpoint.href, options })
    expect(signal.aborted).toBe(false)
    return html(post)
  }
  const resolved = await fetchPublicWeiboPost({ uid, id: bid }, undefined, fetch)
  expect(resolved).toMatchObject({ id, uid, url, author: "样本作者", content: "样本动态\n第二行", images: ["https://wx1.sinaimg.cn/example.jpg"] })
  expect(requests).toEqual([{ endpoint: `https://m.weibo.cn/detail/${bid}`, options: {
    method: "GET", credentials: "omit", redirect: "manual", headers: { Accept: "text/html", "User-Agent": "Lotus-Yunzai" },
  } }])
})

test("微博详情页无正文时只向官方同源 API 求证，错作者与错帖子都不收录", async () => {
  const redirects = []
  const fetch = async (endpoint, { headers, redirect }) => {
    redirects.push(endpoint.href)
    expect(redirect).toBe("manual")
    expect(new Headers(headers).has("Cookie")).toBe(false)
    if (endpoint.pathname.startsWith("/detail/")) return Response.redirect("https://passport.weibo.com/visitor/visitor")
    return Response.json({ ok: 1, data: post })
  }
  expect(await fetchPublicWeiboPost({ id }, undefined, fetch)).toMatchObject({ uid, id })
  expect(redirects).toEqual([`https://m.weibo.cn/detail/${id}`, `https://m.weibo.cn/statuses/show?id=${id}`])
  expect(await fetchPublicWeiboPost({ uid: "10099", id: bid }, undefined, fetch)).toBeUndefined()
  expect(await fetchPublicWeiboPost({ uid, id: "another" }, undefined, fetch)).toBeUndefined()
  expect(await fetchPublicWeiboPost({ uid, id }, undefined, async () => html({ ...post, visible: { type: 1 } }))).toBeUndefined()
  expect(await fetchPublicWeiboPost({ uid, id }, undefined, async () => html({ ...post,
    retweeted_status: { ...post, idstr: "1876111111111", visible: { type: 1 } },
  }))).toMatchObject({ id, forwarded: undefined })
  expect(await fetchPublicWeiboPost({ id: "../../other" }, undefined, () => { throw new Error("unexpected fetch") })).toBeUndefined()
})

test("微博热评匿名读取原帖数字 MID，保留回包顺序且最多二十条", async () => {
  const rows = Array.from({ length: 24 }, (_, index) => ({
    id: String(3000 + index), mid: String(3000 + index), rootid: String(3000 + index),
    user: { screen_name: `用户${index}` }, text: `第${index}条<br>第二行<script>隐藏</script><img alt="[笑]">`,
    like_count: index, created_at: "Thu Nov 19 09:20:00 +0800 2026", source: "<span>来自 广东</span>",
  }))
  const request = async (endpoint, options) => {
    expect(endpoint.href).toBe(`https://m.weibo.cn/comments/hotflow?id=${id}&mid=${id}&max_id_type=0`)
    expect(options).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" })
    expect(new Headers(options.headers).has("Cookie")).toBe(false)
    expect(new Headers(options.headers).get("referer")).toBe("https://m.weibo.cn/detail/" + id)
    return Response.json({ ok: 1, data: { status: { comment_manage_info: {} },
      data: [{ ...rows[0], status: { id: "404" } }, rows[0], ...rows], max_id: "ignored" } })
  }
  const result = await fetchPublicWeiboComments(id, undefined, request)
  expect(result).toHaveLength(20)
  expect(result[0]).toEqual({ author: "用户0", text: "第0条\n第二行[笑]", likes: "0",
    createdAt: Date.parse(post.created_at) / 1000, source: "来自 广东" })
  expect(result.at(-1)?.author).toBe("用户19")
  const unexpected = () => { throw new Error("unexpected request") }
  expect(await fetchPublicWeiboComments(bid, undefined, unexpected)).toEqual([])
  await expect(fetchPublicWeiboComments(id, AbortSignal.abort(), unexpected)).rejects.toThrow()
  for (const response of [
    Response.redirect("https://passport.weibo.com/visitor"), new Response("", { status: 429 }),
    Response.json({ ok: 0, data: { data: rows } }), new Response("broken"), new Response("x".repeat(512 * 1024 + 1)),
    Response.json({ ok: 1, data: { status: { id: "404" }, data: rows } }),
  ]) expect(await fetchPublicWeiboComments(id, undefined, async () => response)).toEqual([])
})

test("微博热评附加到原会话预览，关闭、不可读、限额和取消时保持对应边界", async () => {
  let settings = settingsFor({})
  let results = [{ author: "样本评论者", text: "热评内容", likes: "0",
    createdAt: Date.parse(post.created_at) / 1000, source: "来自 广东" }]
  let signal
  let calls = 0
  const renderScales = []
  const preview = createWeiboPreview({
    settings: async () => settings,
    fetchPost: async target => { expect(target).toEqual({ uid, id: bid }); return { id, url } },
    fetchComments: async (mid, active) => {
      expect(mid).toBe(id)
      expect(active?.aborted).toBeFalsy()
      calls++
      if (signal) signal.abort()
      if (results instanceof Error) throw results
      return results
    },
    render: async () => [["原帖内容", url]],
    renderCommentCard: async (template, card, { renderScale }) => {
      expect(template).toBe("status")
      expect(card.items[0]).toContain("样本评论者\n热评内容")
      renderScales.push(renderScale)
      return Buffer.alloc(renderScale === 4 ? 1024 : 256)
    },
  })
  const context = { normalizedMessage: url, message_type: "group", inlineImageByteLimit: 2048 }
  expect(await preview.fallback(url, context)).toMatchObject({ type: "forward", nodes: [["原帖内容", url], { type: "image" }] })
  expect(await preview.fallback(url, { ...context, inlineImageByteLimit: 512 })).toMatchObject({
    type: "forward", nodes: [["原帖内容", url], { type: "image", file: Buffer.alloc(256) }],
  })
  expect(await preview.fallback(url, { ...context, inlineImageByteLimit: 32 })).toMatchObject({
    type: "forward", nodes: [["原帖内容", url], { type: "text", text: expect.stringMatching(/热评内容\n赞 0 · .*09:20 · 来自 广东/u) }],
  })
  expect(renderScales).toEqual([4, 4, 2, 4, 2])
  expect(await preview.fallback(url, { ...context, message_type: "private" })).toBeUndefined()
  expect(await preview.fallback(url, { ...context, isDelegated: true })).toBeUndefined()
  settings = settingsFor({ weiboComments: false })
  expect(await preview.fallback(url, context)).toEqual(["原帖内容", url])
  expect(calls).toBe(3)
  settings = settingsFor({})
  results = new Error("上游公开热评不可读")
  expect(await preview.fallback(url, context)).toEqual(["原帖内容", url])
  signal = new AbortController()
  expect(await preview.fallback(url, { ...context, groupActivitySignal: signal.signal })).toBeUndefined()
  expect(calls).toBe(5)
})

test("动态模块接出微博桌面和分享卡直链，上游登录限制保留原文，面板开关即时生效", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-weibo-preview-"))
  const config = join(directory, "yuki-plugin", "config", "weibo")
  const requests = []
  let reply
  const plugin = await createSubscriptionModule({ lockFile }, {
    directory, getRedis: () => undefined,
    fetchWeiboPost: async target => { requests.push(target); return reply },
    render: async (provider, detail, settings, options) => {
      expect(provider.id).toBe("weibo")
      expect(settings.parseWeiboLink).toBe(true)
      expect(options).toMatchObject({ preview: true, inlineImageByteLimit: 4096 })
      return [`${detail.author} ${detail.content}`, detail.url]
    },
  })
  const context = { message_type: "group", inlineImageByteLimit: 4096, normalizedMessage: url }
  try {
    expect(plugin.features(context)).toContain("[media] 微博解析")
    expect(await plugin.fallback(`来看 ${url}.`, context)).toMatch(/无法匿名读取.*\nhttps:\/\/weibo\.com/u)
    reply = { author: "样本作者", content: "样本动态", url }
    const card = { type: "json", data: JSON.stringify({ jumpUrl: `https://m.weibo.cn/status/${bid}` }) }
    expect(await plugin.fallback("", { ...context, message: [card] })).toEqual({ type: "forward", nodes: ["样本作者 样本动态", url] })
    expect(await plugin.fallback(`https://weibo.com/tv/show/1034:1?mid=${id}&utm_source=other`, context)).toMatchObject({ type: "forward" })
    for (const input of ["https://weibo.com.evil.test/12/ab", "https://weibo.com@evil.test/12/ab", `#搜歌 ${url}`,
      "https://weibo.com:1080/12/ab", "https://weibo.com/not-an-uid/about", "https://evil.test/?target="+url]) {
      expect(await plugin.fallback(input, { ...context, normalizedMessage: input })).toBeUndefined()
    }
    expect(await plugin.fallback(url, { ...context, isDelegated: true })).toBeUndefined()
    expect(await plugin.fallback(url, { ...context, groupActivitySignal: AbortSignal.abort() })).toBeUndefined()
    expect(await plugin.fallback(url, { ...context, message_type: "private" })).toBeUndefined()
    await mkdir(config, { recursive: true })
    await writeFile(join(config, "config.guoba.support.yaml"), "parseWeiboPrivate: true\n")
    expect(await plugin.fallback(url, { ...context, message_type: "private" })).toMatchObject({ type: "forward" })
    await writeFile(join(config, "config.guoba.support.yaml"), "parseWeiboLink: false\n")
    expect(await plugin.fallback(url, context)).toBeUndefined()
    expect(requests).toEqual([{ uid, id: bid }, { id: bid }, { id }, { uid, id: bid }])
  } finally {
    await plugin.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
