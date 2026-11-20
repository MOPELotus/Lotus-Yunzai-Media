import { expect, test } from "bun:test"
import { createWeiboProvider } from "../services/subscriptions/weibo/index.js"
import { settingsFor } from "../services/subscriptions/config.js"
import { makeDynamicMessages } from "../services/subscriptions/render.js"

const uid = "2803301701"
const created_at = "Thu Nov 19 09:20:00 +0800 2026"
const createdAt = Date.parse(created_at) / 1000
const user = { id: 2803301701, screen_name: "公开账号", profile_image_url: "//tva1.sinaimg.cn/avatar.jpg" }
const picture = url => ({ large: { url } })
const card = mblog => ({ card_type: 9, mblog: { created_at, user, ...mblog } })

test("微博正常匿名 GET 按旧容器拉取主页及动态，保留原文链接和带图转发", async () => {
  const requests = []
  const post = card({
    mid: "9999999999999999", id: 12, bid: "Qq012Aa",
    attitudes_count:12000, comments_count:0, reposts_count:"3.4万",
    text: '转载<br>正文 &amp; <a href="https://evil.invalid">原文</a><script>脚本</script><img alt="[笑]" src="https://evil.invalid">',
    pics: [picture("https://wx1.sinaimg.cn/repost.jpg")],
    retweeted_status: {
      idstr: "9999999999999998", created_at, bid: "Qq012Ba",
      attitudes_count:0, comments_count:"无数据", reposts_count:7,
      user: { id: 42, screen_name: "来源账号" }, text: "<p>原帖 &lt;文字&gt;</p>",
      pics: [picture("http://wx1.sinaimg.cn/original.jpg"),
        picture("https://wx1.sinaimg.cn/original.jpg"), picture("https://evil.invalid/x")],
    },
  })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url)
    requests.push({ url, method: request.method, credential: request.headers.get("Cookie"), token: request.headers.get("Authorization"),
      agent: request.headers.get("User-Agent") })
    if (url.searchParams.get("containerid") === `100505${uid}`) {
      return Response.json({ ok: 1, data: { userInfo: { ...user, description: "账号简介",
        gender: "f", verified_reason: "公开认证", followers_count_str: "12.4万", follow_count: 0 } } })
    }
    return Response.json({ ok: 1, data: { cards: [
      { card_type: 11, mblog: post.mblog }, post, post,
      card({ mid: "12344", text: "推荐内容", user: { id: 42 } }),
      card({ mid: "12345", text: "只有正文", bid: "../not-a-link" }),
      card({ mid: "12346", text: "视频正文<br>第二行", page_info: { type: "video", title: "视频标题", page_pic: { url: "//wx1.sinaimg.cn/cover.jpg" } } }),
    ] } })
  } })
  try {
    const source = createWeiboProvider({ fetch: (input, init) => {
      expect(input.origin).toBe("https://m.weibo.cn")
      expect(init.credentials).toBe("omit")
      expect(init.redirect).toBe("manual")
      return fetch(new URL(input.pathname + input.search, server.url), { ...init, proxy: false })
    } })
    expect(await source.profile(uid)).toMatchObject({ uid, name: "公开账号", summary: "账号简介", gender: "女",
      verification: "公开认证", followers: "12.4万", following: "0" })
    const posts = await source.fetchPosts(uid)
    expect(posts.map(post => post.id)).toEqual(["9999999999999999", "12345", "12346"])
    expect(posts[0]).toMatchObject({
      id: "9999999999999999", uid, author: "公开账号", createdAt, type: "DYNAMIC_TYPE_FORWARD",
      content: "转载\n正文 & 原文[笑]", url: `https://weibo.com/${uid}/Qq012Aa`,
      avatar: "https://tva1.sinaimg.cn/avatar.jpg", images: ["https://wx1.sinaimg.cn/repost.jpg"],
      forwarded: { id: "9999999999999998", uid: "42", author: "来源账号", content: "原帖 <文字>",
        type: "DYNAMIC_TYPE_DRAW", url: "https://weibo.com/42/Qq012Ba", images: ["https://wx1.sinaimg.cn/original.jpg"] },
    })
    expect(posts[1]).toMatchObject({ type: "DYNAMIC_TYPE_ARTICLE", content: "只有正文", url: "https://m.weibo.cn/detail/12345" })
    expect(posts[2]).toMatchObject({ type: "DYNAMIC_TYPE_AV", title: "视频标题", cover: "https://wx1.sinaimg.cn/cover.jpg" })
    const [repost]=await makeDynamicMessages(source,posts[0],settingsFor({pushMsgMode:0,mergeTextPic:0}))
    expect(repost.text).toContain(`1.2万点赞 • 0评论 • 3.4万转发\n转发链接：https://weibo.com/${uid}/Qq012Aa\n原帖 · 图文 · 来源账号`)
    expect(repost.text.match(/投稿：2026年11月19日 09:20:00/gu)).toHaveLength(2)
    expect(repost.text).toEndWith("原帖 <文字>\n0点赞 • 7转发\n原帖链接：https://weibo.com/42/Qq012Ba")
    const [video]=await makeDynamicMessages(source,posts[2],settingsFor({pushMsgMode:0,mergeTextPic:0,
      pushContentLenLimit:2,pushContentLineLimit:1}))
    expect(video.text).toContain("视频标题\n视频正文\n第二行\n链接：")
    expect(requests.map(({ url }) => Object.fromEntries(url.searchParams))).toEqual([
      { type: "uid", value: uid, containerid: `100505${uid}` }, { containerid: `107603${uid}` },
    ])
    expect(requests.every(({ method, credential, token, agent }) =>
      method === "GET" && !credential && !token && agent === "Lotus-Yunzai")).toBe(true)
  } finally {
    await server.stop(true)
  }
})

test("微博仅将明确无内容识别为空结果，登录和限流保留接口失败", async () => {
  const provider = response => createWeiboProvider({ fetch: async () => response })
  for (const response of [
    new Response("fixture-visitor-response", { status: 432 }),
    new Response(null, { status: 302, headers: { Location: "https://passport.weibo.com/" } }),
    Response.json({ ok: 0, msg: "需要登录" }),
    Response.json({ ok: 1, data: {} }),
    new Response("<html>请登录</html>"),
  ]) await expect(provider(response).fetchPosts(uid)).rejects.toThrow(/微博/u)
  expect(await provider(Response.json({ ok: 0, msg: "这里还没有内容" })).fetchPosts(uid)).toEqual([])
  expect(await provider(Response.json({ ok: 0, msg: "用户不存在" })).profile(uid)).toBeUndefined()
  await expect(provider(Response.json({ ok: 1, data: { userInfo: { id: 42, screen_name: "错号" } } })).profile(uid))
    .rejects.toThrow("账号信息不匹配")
  await expect(createWeiboProvider({ fetch: () => { throw new Error("不应发送请求") } }).fetchPosts("12&foo=1"))
    .rejects.toThrow("UID 无效")
})

test("微博公开详情只补同一动态的长文和多图，失败保留短内容", async () => {
  const requests = []
  const pics = Array.from({ length: 12 }, (_, i) => picture(`https://wx1.sinaimg.cn/${i + 1}.jpg`))
  const feed = [
    card({ mid: "12340", pic_num: 12, pics: pics.slice(0,9), bid: "Outer", text: "短文", isLongText: true }),
    card({ mid: "12341", text: "被拒绝", isLongText: true }),
    card({ mid: "12342", text: "错号保留", isLongText: true }),
    card({ mid: "12343", text: "内联短文", isLongText: true,
      longText: { longTextContent: "内联全文" }, pic_num: 12, pics }),
    card({ mid: "12344", text: "时间窗外", isLongText: true, created_at: "Thu Nov 19 08:00:00 +0800 2026" }),
    card({ mid: "12345", text: "转发", retweeted_status: {
      mid: "12375", user, created_at, pic_num: 12, pics: pics.slice(0,9), text: "原帖短文", isLongText: true,
    } }),
    card({ mid: "12346", text: "网络失败", isLongText: true }),
  ]
  const detail = raw => new Response(`<script>var data = [{"status": ${JSON.stringify(raw)}, "call": 1}];</script>`)
  const source = createWeiboProvider({ fetch: async (input, init) => {
    requests.push(input.pathname)
    expect(input.origin).toBe("https://m.weibo.cn")
    expect(init.credentials).toBe("omit")
    expect(init.redirect).toBe("manual")
    if (input.pathname.endsWith("getIndex")) return Response.json({ ok: 1, data: { cards: feed } })
    switch (input.pathname.split("/").at(-1)) {
      case "12340":
        return detail({ mid:"12340", user, pics, text:"<p>短文<br>续文</p>" })
      case "12341":
        return new Response(null,{ status:432 })
      case "12342":
        return detail({ mid:"12342", user:{id:42}, text:"不可信额外内容" })
      case "12345":
        return detail({ mid:"12345", user, retweeted_status:{mid:"12375",user, pics, text:"原帖短文<br>原帖续文"} })
      case "12346":
        throw new TypeError("网络失败")
      default:
        throw new Error("不应请求此详情")
    }
  } })
  const posts = await source.fetchPosts(uid,{ oldest:createdAt-60 })
  expect(posts.map(post=>post.content)).toEqual(["短文\n续文","被拒绝","错号保留","内联全文","时间窗外","转发","网络失败"])
  expect(posts[0]).toMatchObject({ id:"12340", createdAt, url:`https://weibo.com/${uid}/Outer`, images:pics.map(pic=>pic.large.url) })
  expect(posts[5].forwarded).toMatchObject({ id:"12375", content:"原帖短文\n原帖续文", images:pics.map(pic=>pic.large.url) })
  expect(requests).toEqual(["/api/container/getIndex","/detail/12340","/detail/12341","/detail/12342","/detail/12345","/detail/12346"])
})

test("微博搜索兼容旧用户卡片，调用取消时不读取上游", async () => {
  let query
  const source = createWeiboProvider({ fetch: async input => {
    query = Object.fromEntries(input.searchParams)
    return Response.json({ ok: 1, data: { cards: [{ card_group: [
      { card_type: 10, user: { ...user, followers_count: 567, followers_count_str: "万" } },
      { card_type: 3, users: [user, { id: 42, screen_name: "另一账号", followers_count: -1 }] },
    ] }] } })
  } })
  expect(await source.search(" 测试 & 关键词 ")).toMatchObject([
    { uid, name: "公开账号", followers: "567" }, { uid: "42", name: "另一账号", followers: undefined },
  ])
  expect(query).toEqual({ type: "1", containerid: "100103", q: "测试 & 关键词", page_type: "searchall" })
  query = undefined
  await expect(source.fetchPosts(uid, { signal: AbortSignal.abort() })).rejects.toThrow()
  expect(query).toBeUndefined()
})
