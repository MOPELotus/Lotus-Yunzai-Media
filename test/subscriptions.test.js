import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import YAML from "yaml"
import { lockFile } from "../../../lib/file-lock.ts"
import { changeTypes, createSubscriptionConfig, settingsFor } from "../services/subscriptions/config.ts"
import { createBiliProvider, biliTypes, normalizeBiliDynamic } from "../services/subscriptions/bilibili/index.ts"
import { articleContent } from "../services/subscriptions/bilibili/article.ts"
import { createSubscriptionDelivery, receiptKey, useDynamicForward } from "../services/subscriptions/delivery.ts"
import { createSubscriptionModule } from "../services/subscriptions/module.ts"
import { makeDynamicMessages } from "../services/subscriptions/render.ts"
import { renderSubscriptionHelp } from "../services/subscriptions/help.ts"
import { createBilibiliVideoCommands } from "../services/bilibili/video-command.ts"
import { milkyMessage } from "../../../lib/adapters/milky-message.ts"
import { CommandRegistry } from "../../../lib/commands.ts"

const temp=[]
async function directory() {
  const root=await mkdtemp(join(tmpdir(),"lotus-media-subscriptions-"))
  temp.push(root)
  return root
}
afterEach(async()=>Promise.all(temp.splice(0).map(root=>rm(root,{force:true,recursive:true}))))

const seen=1700000000
const uid="401742377"
const draw="DYNAMIC_TYPE_DRAW"
const article="DYNAMIC_TYPE_ARTICLE"
const route={kind:"group",chat:"77",bot:"99",uid,name:"原神",types:[]}

function raw(type=draw,fields={}) {
  return { id_str:"12234455",type,
    modules:{module_author:{mid:uid,pub_ts:seen,name:"试验发布者"},module_dynamic:fields} }
}

test("同号 Milky 群不能翻页或选择 OneBot 的 B 站搜索结果", async () => {
  const bvid = "BV1dAxE6VErW"
  const offsets = []
  const replies = []
  const api = createBilibiliVideoCommands({ async fetch(input) {
    const url = new URL(input)
    expect(url.pathname).toBe("/v1/search")
    offsets.push(url.searchParams.get("offset"))
    return Response.json({ ok: true, data: [{ type: "video", data: { id: bvid, title: "测试视频" } }] })
  } })
  const onebot = { message_type: "group", self_id: 99, user_id: 42, group_id: 77,
    reply: async value => { replies.push(value); return true } }
  const milky = { ...onebot, adapter: "milky" }
  try {
    expect(await api.fallback("#点B站视频 测试", onebot)).toEqual([])
    expect(offsets).toEqual(["0"])
    expect(replies.at(-1)).toMatchObject({ type: "image" })
    expect(await api.fallback("#B站下一页", milky)).toContain("请先发送")
    expect(await api.fallback("#看B站视频 1", milky)).toContain("搜索结果已过期")
    expect(await api.fallback("#B站下一页", onebot)).toEqual([])
    expect(offsets).toEqual(["0", "42"])
  } finally {
    await api.dispose()
  }
})

test("引用已确认送达的同群 B 站动态可取原图，图片字节独立验限", async () => {
  const image = "https://i0.hdslb.com/bfs/new_dyn/example.png"
  const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7LQMcAAAAASUVORK5CYII=", "base64")
  const requests = []
  const deliveries = []
  const controller = new AbortController()
  const api = createBilibiliVideoCommands({ signal: controller.signal,
    settings: async () => settingsFor({ parseVideoLink: true, pushMsgMode: 0, pushPicCountLimit: 0 }),
    async fetch(input, options) {
      requests.push(String(input))
      expect(options.credentials).toBe("omit")
      if (String(input) === image) {
        expect(options.redirect).toBe("error")
        expect(options.headers).toBeUndefined()
        return new Response(original, { headers: { "Content-Type": "image/png" } })
      }
      return Response.json({ code: 0, data: { item: raw(draw, {
        desc: { text: "被引用的动态原图" },
        major: { draw: { items: [{ src: image }] } },
      }) } })
    },
  })
  const context = {
    message_type: "group", self_id: 99, user_id: 42, group_id: 77,
    reply: async (message, _, options) => {
      deliveries.push(message)
      await options?.onDelivered?.(10)
      return true
    },
  }
  const source = { user_id: 99, message: [{ type: "image" }] }
  const quoted = { ...context, reply_id: 10, lookupReply: async () => source }
  try {
    expect(await api.fallback("https://t.bilibili.com/12234455", context)).toEqual([])
    const checked = requests.length
    expect(await api.fallback("获取图片", { ...quoted, group_id: 78 })).toBeUndefined()
    expect(await api.fallback("获取图片", { ...quoted, adapter: "milky" })).toBeUndefined()
    expect(await api.fallback("获取图片", { ...quoted, reply_id: 11 })).toBeUndefined()
    expect(await api.fallback("获取图片", { ...quoted, lookupReply: async () => ({ ...source, user_id: 43 }) })).toBeUndefined()
    expect(requests).toHaveLength(checked)
    expect(await api.fallback("获取图片", quoted)).toEqual([])
    expect(deliveries.at(-1)).toEqual({ type: "image", file: original })
    expect(await api.fallback("画像", quoted)).toBeUndefined()
    expect(await api.fallback("下载图片", { ...quoted, inlineImageByteLimit: 16 })).toContain("没有可以发送")
    expect(deliveries).toHaveLength(2)
  } finally {
    await api.dispose()
  }
})

test("B 站分享卡可单独取视频封面与简介，且遵守解析开关", async () => {
  const bvid = "BV1dAxE6VErW"
  const image = "https://i0.hdslb.com/bfs/archive/quoted.png"
  const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7LQMcAAAAASUVORK5CYII=", "base64")
  const requests = []
  const deliveries = []
  let enabled = true
  const api = createBilibiliVideoCommands({
    settings: async () => settingsFor({ parseVideoLink: enabled }),
    async fetch(input, options) {
      const url = new URL(input)
      requests.push(url.href)
      if (url.href === image) {
        expect(options.credentials).toBe("omit")
        return new Response(original, { headers: { "Content-Type": "image/png" } })
      }
      if (url.pathname.endsWith("/parts")) return Response.json({ ok: true, data: [] })
      expect(url.pathname).toBe("/v1/videos/bilibili%3Abvid%3A" + bvid)
      return Response.json({ ok: true, data: { video: {
        ref: "bilibili:bvid:" + bvid, title: "旧封面入口", description: "<p>正文简介</p>", cover_url: image,
        extensions: { bvid },
      } } })
    },
  })
  const context = {
    message_type: "private", self_id: 99, user_id: 42, reply_id: 12,
    lookupReply: async () => ({ user_id: 42, message: [
      { type: "json", data: { meta: { news: { jumpUrl: "https://www.bilibili.com/video/" + bvid } } } },
    ] }),
    reply: async data => { deliveries.push(data); return true },
  }
  try {
    expect(await api.fallback("获取封面", context)).toEqual([])
    expect(deliveries).toEqual([{ type: "image", file: original }])
    expect(await api.fallback("简介", context)).toBe("正文简介")
    expect(requests.filter(url => url === image)).toHaveLength(1)
    const checked = requests.length
    enabled = false
    expect(await api.fallback("获取封面", context)).toBeUndefined()
    expect(requests).toHaveLength(checked)
  } finally {
    await api.dispose()
  }
})

test("B站动态链接从媒体入口识别直链、分享卡和短链，复用转发原帖正文", async () => {
  const post = { ...raw("DYNAMIC_TYPE_FORWARD", { desc: { text: "转发正文" } }), id_str: "12234456",
    orig: raw("DYNAMIC_TYPE_WORD", { desc: { text: "原帖正文" } }) }
  const requests = []
  const controller = new AbortController()
  let enabled = true
  let result = post
  const api = createBilibiliVideoCommands({ signal: controller.signal,
    settings: async () => settingsFor({ parseVideoLink: enabled, pushMsgMode: 0 }),
    async fetch(input, options) {
      const url = new URL(input)
      expect(options.credentials).toBe("omit")
      expect(new Headers(options.headers).has("cookie")).toBe(false)
      expect(new Headers(options.headers).has("authorization")).toBe(false)
      requests.push(url.href)
      if (url.hostname === "b23.tv") {
        expect(options.method).toBe("HEAD")
        expect(options.redirect).toBe("manual")
        return new Response(null, { status: 302, headers: { location: "https://m.bilibili.com/dynamic/12234456" } })
      }
      expect(url.origin + url.pathname).toBe("https://api.bilibili.com/x/polymer/web-dynamic/v1/detail")
      expect(url.searchParams.get("id")).toBe(post.id_str)
      expect(url.searchParams.has("from")).toBe(false)
      expect(options.redirect).toBe("error")
      return Response.json({ code: 0, data: { item: result } })
    },
  })
  const replies = []
  async function send(text, message = undefined, message_type = "group") {
    return api.fallback(text, { normalizedMessage: text, raw_message: text, message, message_type, self_id: 99,
      group_id: 77, user_id: 42, reply: async data => { replies.push(data); return true } })
  }
  try {
    for (const link of ["分享（https://t.bilibili.com/12234456?from=app）", "https://www.bilibili.com/opus/12234456",
      "https://m.bilibili.com/opus/12234456", "https://m.bilibili.com/dynamic/12234456", "b23.tv/shared"]) {
      expect(await send(link)).toEqual([])
    }
    expect(await send("[json消息]", [{ type: "json", data: { meta: { news: { jumpUrl: "https://t.bilibili.com/12234456" } } } }])).toEqual([])
    expect(replies).toHaveLength(6)
    expect(replies[0].text).toContain("转发正文\n转发链接：https://m.bilibili.com/dynamic/12234456")
    expect(replies[0].text).toContain("原帖正文\n原帖链接：https://m.bilibili.com/dynamic/12234455")
    expect(requests.filter(url => url.includes("/detail?")).length).toBe(6)

    const checked = requests.length
    expect(await send("https://t.bilibili.com.other.invalid/12234456")).toBeUndefined()
    expect(await send("https://other.invalid/?r=https://t.bilibili.com/12234456")).toBeUndefined()
    expect(await send("https://t.bilibili.com/12234456/extra")).toBeUndefined()
    expect(await send("https://t.bilibili.com/12234456", undefined, "terminal")).toBeUndefined()
    enabled = false
    expect(await send("https://t.bilibili.com/12234456")).toBeUndefined()
    expect(requests).toHaveLength(checked)

    enabled = true
    result = { ...post, id_str: "12234457" }
    expect(await send("https://t.bilibili.com/12234456")).toContain("动态不可用")
    controller.abort()
    expect(await send("https://t.bilibili.com/12234456")).toBeUndefined()
    expect(replies).toHaveLength(6)
  } finally {
    await api.dispose()
  }
})

test("引用会话中的 QQ 卡片可明确解析动态，拒绝跨会话、站外及引用文字", async () => {
  const api = createBilibiliVideoCommands({
    settings: async () => settingsFor({ parseVideoLink: enabled, pushMsgMode: 0 }),
    async fetch(input, options) {
      const url = new URL(input)
      requests.push(url.href)
      if (url.hostname === "b23.tv") {
        expect(options.method).toBe("HEAD")
        expect(url.search).toBe("")
        const location = url.pathname === "/valid" ? "https://m.bilibili.com/opus/12234455" : "https://elsewhere.invalid/12234455"
        return new Response(null, { status: 302, headers: { location } })
      }
      expect(url.origin + url.pathname).toBe("https://api.bilibili.com/x/polymer/web-dynamic/v1/detail")
      expect(url.searchParams.get("id")).toBe("12234455")
      return Response.json({ code: 0, data: { item: raw("DYNAMIC_TYPE_WORD", { desc: { text: "被引用的动态" } }) } })
    },
  })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "@lotus-yunzai/media", commands: {}, fallback: api.fallback, fallbackFeatures: api.features })
  const requests = []
  const replies = []
  const lookups = []
  let enabled = true
  let source
  function card(link, field = "detail_1") {
    const body = { meta: { [field]: { [field === "news" ? "jumpUrl" : "qqdocurl"]: link } } }
    return { type: "light_app", data: { data: JSON.stringify(body) } }
  }
  async function send(text, { quote = true, messageScene = "group", allowed = true, delegated = false } = {}) {
    const peer = messageScene === "group" ? 77 : 42
    const event = milkyMessage({ event_type: "message_receive", self_id: 99, data: {
      message_scene: messageScene, peer_id: peer, sender_id: 42, message_seq: 5,
      segments: [...(quote ? [{ type: "reply", data: { message_seq: 4 } }] : []), { type: "text", data: { text } }],
    } }, 99, async (action, params) => {
      if (action === "get_message") {
        lookups.push(params)
        return { message: source && { message_scene: messageScene, peer_id: peer, message_seq: 4, sender_id: 43, ...source } }
      }
      replies.push([action, params])
    })
    return registry.dispatchFallback({ ...event, isDelegated: delegated },
      names => allowed || !names.includes("[media] B 站解析"), () => false)
  }
  try {
    source = { segments: [card("https://t.bilibili.com/12234455?share_uid=42")] }
    expect(await send("解析")).toEqual([])
    source = { segments: [card("https://b23.tv/valid?share_uid=42", "news")] }
    expect(await send("#解", { messageScene: "friend" })).toBeUndefined()
    source.sender_id = 42
    expect(await send("#解", { messageScene: "friend" })).toEqual([])
    expect(lookups).toEqual([
      { message_scene: "group", peer_id: 77, message_seq: 4 },
      { message_scene: "friend", peer_id: 42, message_seq: 4 },
      { message_scene: "friend", peer_id: 42, message_seq: 4 },
    ])
    expect(replies.map(([name, params]) => [name, params.group_id ?? params.user_id])).toEqual([
      ["send_group_message", 77], ["send_private_message", 42],
    ])
    expect(JSON.stringify(replies)).toContain("被引用的动态")
    expect(requests).toHaveLength(3)

    source.peer_id = 78
    expect(await send("解")).toBeUndefined()
    source = { segments: [{ type: "text", data: { text: "https://t.bilibili.com/12234455" } }] }
    expect(await send("解析")).toBeUndefined()
    source = { segments: [card("https://wrong.invalid/?url=https://t.bilibili.com/12234455")] }
    expect(await send("解析")).toBeUndefined()
    expect(requests).toHaveLength(3)

    source = { segments: [card("https://t.bilibili.com/12234455")] }
    const queried = lookups.length
    expect(await send("解析说明")).toBeUndefined()
    expect(await send("解析", { quote: false })).toBeUndefined()
    expect(await send("解析", { allowed: false })).toBeUndefined()
    expect(await send("解析", { delegated: true })).toBeUndefined()
    enabled = false
    expect(await send("解析")).toBeUndefined()
    expect(lookups).toHaveLength(queried)
    expect(requests).toHaveLength(3)
    expect(replies).toHaveLength(2)

    enabled = true
    source = { segments: [card("https://b23.tv/invalid")] }
    expect(await send("解析")).toBeUndefined()
    expect(requests.slice(3)).toEqual(["https://b23.tv/invalid"])
    expect(replies).toHaveLength(2)
  } finally {
    await api.dispose()
  }
})

test("B 站旧图文标题进入推送，Opus 保留自己的标题",async()=>{
  const provider=createBiliProvider()
  const settings=settingsFor({pushMsgMode:0})
  const desc={title:"旧图文标题",text:"正文"}
  for (const type of [draw,"DYNAMIC_TYPE_WORD"]) {
    const post=normalizeBiliDynamic(raw(type,{desc}),uid)
    const [message]=await makeDynamicMessages(provider,post,settings)
    expect(message.text).toContain("旧图文标题\n正文\n链接：")
  }
  const opus=normalizeBiliDynamic(raw(draw,{desc,major:{opus:{title:"新图文标题"}}}),uid)
  expect(opus.title).toBe("新图文标题")
  const malformed=normalizeBiliDynamic(raw(draw,{desc:{title:{},text:"正文"}}),uid)
  expect(malformed.title).toBe("")
})

test("B站动态解析适配 Opus 图文、直播、原转发与来源域",()=>{
  const original=raw(draw,{major:{opus:{title:"标题",summary:{rich_text_nodes:[{text:"正文"},{"text":"#话题#"}]},pics:[
    {url:"//i0.hdslb.com/test.webp"},{url:"https://wrong.test/a.png"},
  ]}}})
  const forwarded=normalizeBiliDynamic({...raw("DYNAMIC_TYPE_FORWARD",{desc:{text:"转发文字"}}),id_str:"12234456",orig:original},uid)
  expect(forwarded).toMatchObject({id:"12234456",content:"转发文字",forwarded:{content:"正文#话题#",images:["https://i0.hdslb.com/test.webp"]}})
  const live=normalizeBiliDynamic(raw("DYNAMIC_TYPE_LIVE_RCMD",{major:{live_rcmd:{content:JSON.stringify({live_play_info:{
    title:"直播",link:"//live.bilibili.com/12",cover:"//i0.hdslb.com/live.jpg",
  }})}}}),uid)
  expect(live).toMatchObject({title:"直播",url:"https://live.bilibili.com/12",cover:"https://i0.hdslb.com/live.jpg"})
  expect(normalizeBiliDynamic(original,"123")).toBeUndefined()
})

test("B站视频和直播的文字推送保留原动态类别字段和明确的链接",async()=>{
  const provider=createBiliProvider()
  const settings=settingsFor({pushMsgMode:0,mergeTextPic:0,pushContentLenLimit:2,pushContentLineLimit:1})
  const videoRaw=raw("DYNAMIC_TYPE_AV",{major:{archive:{title:"视频标题",desc:"视频简介\n第二行详细资料",jump_url:"//www.bilibili.com/video/BV1234567890",
    cover:"//i0.hdslb.com/video.jpg",stat:{play:"1.2万",danmaku:"0"},
  }}})
  videoRaw.modules.module_stat={like:{count:23},comment:{count:0},forward:{count:"无数据"}}
  const post=normalizeBiliDynamic(videoRaw,uid)
  const [video,attachment]=await makeDynamicMessages(provider,post,settings)
  expect(video.type).toBe("text")
  expect(video.text).toContain("投稿：2023年11月15日 06:13:20")
  expect(video.text).toContain("视频简介\n第二行详细资料")
  const [hidden]=await makeDynamicMessages(provider,post,{...settings,contentLimit:0})
  expect(hidden.text).not.toContain("视频简介")
  expect(video.text).toContain("0弹幕 • 1.2万播放 • 23点赞 • 0评论")
  expect(video.text).not.toContain("转发")
  expect(video.text).toEndWith("https://www.bilibili.com/video/BV1234567890")
  expect(attachment).toEqual({type:"image",file:"https://i0.hdslb.com/video.jpg"})

  const repost={...raw("DYNAMIC_TYPE_FORWARD",{desc:{text:"转发说明"}}),id_str:"12234456",orig:videoRaw}
  const [forwarded]=await makeDynamicMessages(provider,normalizeBiliDynamic(repost,uid),settings)
  expect(forwarded.text).toContain("转发...\n转发链接：")
  expect(forwarded.text).toContain("视频简介\n第二行详细资料")

  const liveRaw=({link,live_start_time})=>raw("DYNAMIC_TYPE_LIVE_RCMD",{major:{live_rcmd:{content:JSON.stringify({live_play_info:{
    title:"直播标题",link,parent_area_name:"单机游戏",area_name:"原神",live_start_time,watched_show:{num:0},
  }})}}})
  const [live]=await makeDynamicMessages(provider,normalizeBiliDynamic(liveRaw({
    link:"//live.bilibili.com/12",live_start_time:seen-60,
  }),uid),settings)
  expect(live.text).toContain("开播：2023年11月15日 06:12:20")
  expect(live.text).toContain("分区：单机游戏 (原神)\n0人看过")
  expect(live.text).toEndWith("直播链接：https://live.bilibili.com/12")
  const [fallback]=await makeDynamicMessages(provider,normalizeBiliDynamic(liveRaw({
    link:"https://other.invalid/12",live_start_time:true,
  }),uid),settings)
  expect(fallback.text).not.toContain("开播：")
  expect(fallback.text).toContain("投稿：2023年11月15日 06:13:20")
  expect(fallback.text).not.toContain("直播链接：")
  expect(fallback.text).toEndWith("https://m.bilibili.com/dynamic/12234455")
})

test("B站转发先给转发帖链接，再给原帖类别、正文和原帖链接",async()=>{
  const provider=createBiliProvider()
  const settings=settingsFor({pushMsgMode:0})
  const original=raw("DYNAMIC_TYPE_WORD",{desc:{text:"原帖正文"}})
  const repost={...raw("DYNAMIC_TYPE_FORWARD",{desc:{text:"转发正文"}}),id_str:"12234456",orig:original}
  original.modules.module_stat={like:{count:"2.5万"},forward:{count:3}}
  repost.modules.module_stat={like:{count:12000},comment:{count:0},forward:{count:-1}}
  const [message]=await makeDynamicMessages(provider,normalizeBiliDynamic(repost,uid),settings)
  expect(message.text).toContain("转发正文\n1.2万点赞 • 0评论\n转发链接：https://m.bilibili.com/dynamic/12234456\n原帖 · 图文 · 试验发布者")
  expect(message.text).toEndWith("原帖正文\n2.5万点赞 • 3转发\n原帖链接：https://m.bilibili.com/dynamic/12234455")
  const [unavailable]=await makeDynamicMessages(provider,normalizeBiliDynamic({...repost,orig:null},uid),settings)
  expect(unavailable.text).toEndWith("转发链接：https://m.bilibili.com/dynamic/12234456")
  expect(unavailable.text).not.toContain("原帖链接")
})

test("B站图文和专栏文字推送只显示合法互动计数",async()=>{
  const provider=createBiliProvider()
  for (const type of [draw,article]) {
    const item=raw(type,{major:{opus:{summary:{text:"公开正文"}}}})
    item.modules.module_stat={like:{count:"未记录"},comment:{count:0},forward:{count:123456}}
    const [message]=await makeDynamicMessages(provider,normalizeBiliDynamic(item,uid),settingsFor({pushMsgMode:0}))
    expect(message.text).toContain("公开正文\n0评论 • 12.3万转发\n链接：")
    expect(message.text).not.toContain("点赞")
  }
})

test("文字正文按旧行数和字数裁剪，跨行和原帖各自保留完整字符",async()=>{
  const provider=createBiliProvider()
  const original=raw("DYNAMIC_TYPE_WORD",{desc:{text:"原句\r\n字🚀超长\r\n末行"}})
  const repost={...raw("DYNAMIC_TYPE_FORWARD",{desc:{text:"转🚀\n发帖超长\n末行"}}),id_str:"12234456",orig:original}
  const unified=normalizeBiliDynamic(repost,uid)
  const text=async options=>(await makeDynamicMessages(provider,unified,settingsFor({pushMsgMode:0,...options})))[0].text
  const both=await text({pushContentLenLimit:4,pushContentLineLimit:2})
  expect(both).toContain("转🚀\n发帖...\n转发链接：")
  expect(both).toContain("原句\n字🚀...\n原帖链接：")
  expect(both).not.toContain("末行")
  const lines=await text({pushContentLenLimit:100,pushContentLineLimit:1})
  expect(lines).toContain("转🚀\n转发链接：")
  expect(lines).not.toContain("...")
  const suppressed=await text({pushContentLenLimit:0,pushContentLineLimit:1})
  expect(suppressed).not.toContain("转🚀")
  expect(suppressed).toEndWith("原帖链接：https://m.bilibili.com/dynamic/12234455")
})

test("B站匿名查询明确区分 HTTP 拒绝并读取原公开文章内嵌数据",async()=>{
  const requests=[]
  const feed=createBiliProvider({fetch:async (u,options)=>{
    requests.push([u,options])
    return new Response(null,{status:412})
  }})
  await expect(feed.fetchPosts(uid)).rejects.toThrow("HTTP 412")
  expect(requests[0][0].searchParams.get("host_mid")).toBe(uid)
  expect(requests[0][1].credentials).toBe("omit")
  expect(articleContent('"readInfo":{"content":"<p>正文</p><img data-src=\\"//i0.hdslb.com/pic.jpg\\">"},"readViewInfo":{}'))
    .toEqual({content:"正文",images:["//i0.hdslb.com/pic.jpg"]})
  const source=raw(article,{major:{opus:{title:"文章",summary:{text:"字".repeat(480)},jump_url:"https://www.bilibili.com/opus/12234455"}}})
  const articleProvider=createBiliProvider({fetch:async url=>url.hostname==="api.bilibili.com"
    ? Response.json({code:0,data:{items:[source]}})
    : new Response('"module_content":'+JSON.stringify({paragraphs:[
      {para_type:1,text:{nodes:[{word:{words:"完整正文".repeat(200)}}]}},
      {para_type:2,pic:{pics:[{url:"//i0.hdslb.com/new.png"}]}},
    ]})+',"module_type":"MODULE_TYPE_CONTENT"')})
  expect((await articleProvider.fetchPosts(uid))[0]).toMatchObject({content:"完整正文".repeat(200),images:["https://i0.hdslb.com/new.png"]})
})

test("订阅只在宿主接管后启动，取消接管或卸载均不继续轮询",async()=>{
  const root=await directory()
  const dir=join(root,"yuki-plugin","config","bilibili")
  await mkdir(dir,{recursive:true})
  await writeFile(join(dir,"config.yaml"),'checkDynamicCD: "* * * * * *"\n')
  await writeFile(join(dir,"push.yaml"),YAML.stringify({group:{77:[{bot_id:99,uid,name:"试验发布者"}]}}))
  let reads=0
  const firstPoll=Promise.withResolvers()
  const providers={bilibili:{id:"bilibili",label:"B站",async fetchPosts() {
    reads++
    firstPoll.resolve()
    return []
  }}}
  let start
  let canceled=0
  const services={
    lockFile,
    subscriptionTransport:()=>[{botId:99,isGroupMember:async()=>true}],
    mediaRuntime:{whenReady(callback) {
      start=callback
      return ()=>{ canceled++ }
    }},
  }
  const options={directory:root,providers,getRedis:()=>({})}
  const candidate=await createSubscriptionModule(services,options)
  try {
    await Bun.sleep(1100)
    expect(reads).toBe(0)
  } finally {
    await candidate.dispose()
  }
  start?.()
  expect(canceled).toBe(1)

  const active=await createSubscriptionModule(services,options)
  try {
    start()
    await Promise.race([
      firstPoll.promise,
      Bun.sleep(1750).then(()=>{ throw new Error("接管后订阅未按旧定时配置执行") }),
    ])
    expect(reads).toBe(1)
  } finally {
    await active.dispose()
  }
  await Bun.sleep(1100)
  expect(canceled).toBe(2)
  expect(reads).toBe(1)
},6500)

test("锅巴配置优先、群与私聊分离，旧类型增删安全保留另一个机器人",async()=>{
  const root=await directory()
  const dir=join(root,"yuki-plugin","config","bilibili")
  await mkdir(dir,{recursive:true})
  await writeFile(join(dir,"push.yaml"),YAML.stringify({group:{77:[]}}))
  await writeFile(join(dir,"config.yaml"),"pushStatus: 0\n")
  await writeFile(join(dir,"config.guoba.support.yaml"),"pushStatus: 1\npushTransmit: 0\n")
  await writeFile(join(dir,"push.guoba.support.yaml"),YAML.stringify({group:{77:[
    {bot_id:99,uid,name:"原群",type:[],metadata:"留"},
    {bot_id:98,uid,name:"另一机器人",type:[draw]},
  ]},private:{42:[{bot_id:99,uid,name:"原私聊"}]}}))
  const cfg=createSubscriptionConfig(root,lockFile)
  expect(await cfg.settings("bilibili")).toMatchObject({enable:true,forwards:false})
  expect((await cfg.routes("bilibili")).length).toBe(3)
  expect(changeTypes([], [draw],Object.keys(biliTypes),"remove")).not.toContain(draw)
  await cfg.update("bilibili",route,uid,"remove",[draw],Object.keys(biliTypes),uid)
  let written=YAML.parse(await readFile(join(dir,"push.guoba.support.yaml"),"utf8"))
  expect(written.group[77][0].metadata).toBe("留")
  expect(written.group[77][0].type).not.toContain(draw)
  expect(written.group[77][1].type).toEqual([draw])
  await cfg.update("bilibili",route,uid,"remove",[],Object.keys(biliTypes),uid)
  written=YAML.parse(await readFile(join(dir,"push.guoba.support.yaml"),"utf8"))
  expect(written.group[77]).toEqual([{bot_id:98,uid,name:"另一机器人",type:[draw]}])
  expect(written.private[42][0].uid).toBe(uid)
  expect(YAML.parse(await readFile(join(dir,"push.yaml"),"utf8"))).toEqual({group:{77:[]}})
})

test("只有明确拒绝访问的 B 站资料可按原 UID 暂存订阅",async()=>{
  const signal=new AbortController().signal
  const denied=[
    {status:403,message:"B 站公开接口 HTTP 403"},{status:412,message:"B 站公开接口 HTTP 412"},
    {code:-403,message:"B 站公开接口返回 -403"},{code:-352,message:"B 站公开接口返回 -352"},
  ]
  for (const {status,code,message} of denied) {
    const provider=createBiliProvider({fetch:async()=>status
      ? new Response(null,{status}) : Response.json({code})})
    await expect(provider.profile(uid,{signal})).rejects.toThrow(message)
    expect(await provider.profile(uid,{signal,allowUnverified:true}))
      .toEqual({uid,name:uid,verificationFailure:message})
  }
  const missing=createBiliProvider({fetch:async()=>Response.json({code:-404})})
  expect(await missing.profile(uid,{signal,allowUnverified:true})).toBeUndefined()
  const broken=createBiliProvider({fetch:async()=>new Response(null,{status:503})})
  await expect(broken.profile(uid,{signal,allowUnverified:true})).rejects.toThrow("HTTP 503")
})

test("聊天指令修改旧订阅文档时保留注释、文件权限和相邻路由",async()=>{
  const root=await directory()
  const dir=join(root,"yuki-plugin","config","bilibili")
  await mkdir(dir,{recursive:true})
  const override=join(dir,"push.guoba.support.yaml")
  const original=`# 文件说明
group:
  77: # 目标群
    - bot_id: 99
      uid: '401742377'
      name: '原神' # 订阅名称
      type: [DYNAMIC_TYPE_WORD] # 原分类
    - {bot_id: 98, uid: '401742377', name: '另一机器人', type: []} # 另一机器人配置
  '78': [] # 保留空群
private:
  '42': # 私聊配置
    - {bot_id: 99, uid: '42', name: '好友', type: []}
custom: &custom {mode: legacy}
alias: *custom # 保留未使用的配置
`
  await writeFile(override,original)
  await chmod(override,0o664)
  const config=createSubscriptionConfig(root,lockFile)
  await config.update("bilibili",route,uid,"add",[draw],Object.keys(biliTypes),"不会覆盖旧显示名")
  const written=await readFile(override,"utf8")
  for (const comment of ["文件说明","目标群","订阅名称","原分类","另一机器人配置","保留空群","私聊配置","保留未使用的配置"]) {
    expect(written).toContain("# "+comment)
  }
  expect(written).toContain("*custom")
  expect(written).toContain("'78': []")
  expect((await stat(override)).mode & 0o777).toBe(0o664)
  const persisted=YAML.parse(written), before=YAML.parse(original)
  before.group[77][0].type.push(draw)
  expect(persisted).toEqual(before)

  await config.update("bilibili",route,uid,"add",[draw],Object.keys(biliTypes),"不变")
  expect(await readFile(override,"utf8")).toBe(written)
  await config.update("bilibili",route,uid,"remove",[],Object.keys(biliTypes),uid)
  const deleted=await readFile(override,"utf8")
  expect(deleted).toContain("# 另一机器人配置")
  expect(YAML.parse(deleted).group[77]).toEqual([before.group[77][1]])
})

test("旧 YAML 锚点复用的会话在修改或移除来源时保留自己的订阅",async()=>{
  const root=await directory()
  const dir=join(root,"yuki-plugin","config","bilibili")
  await mkdir(dir,{recursive:true})
  const file=join(dir,"push.yaml")
  const initial=`group:
  77: &shared
    - {bot_id: 99, uid: '${uid}', name: 原配置, type: [DYNAMIC_TYPE_WORD]}
  78: *shared # 另一个群
`
  const config=createSubscriptionConfig(root,lockFile)
  await writeFile(file,initial)
  await config.update("bilibili",route,uid,"add",[draw],Object.keys(biliTypes),uid)
  const edited=YAML.parse(await readFile(file,"utf8"))
  expect(edited.group[77][0].type).toEqual(["DYNAMIC_TYPE_WORD",draw])
  expect(edited.group[78][0].type).toEqual(["DYNAMIC_TYPE_WORD"])
  await writeFile(file,initial)
  await config.update("bilibili",route,uid,"remove",[],Object.keys(biliTypes),uid)
  const deleted=await readFile(file,"utf8")
  expect(deleted).toContain("# 另一个群")
  expect(YAML.parse(deleted)).toEqual({group:{78:[{bot_id:99,uid,name:"原配置",type:["DYNAMIC_TYPE_WORD"]}]}})
})

test("原动态订阅指令保留权限、别名、分类与当前会话",async()=>{
  const root=await directory()
  const provider={id:"bilibili",label:"B站",typeNames:biliTypes,profile:async uid=>({uid,name:"公开昵称"})}
  const plugin=await createSubscriptionModule({lockFile,groups:{}},{directory:root,providers:{bilibili:provider},getRedis:()=>undefined})
  try {
    const group={self_id:99,user_id:40,group_id:77,message_type:"group",isMaster:true}
    expect(await plugin.fallback("/订阅哔哩推送 图文 UID："+uid,{...group,isMaster:false})).toContain("主人")
    expect(await plugin.fallback("/订阅哔哩推送 图文 UID："+uid,group)).toContain("公开昵称")
    expect(await plugin.fallback("#B站订阅列表",{...group,isMaster:false})).toContain("[图文]")
    expect(await plugin.fallback("#B站订阅列表",{...group,group_id:78})).toContain("当前没有订阅")
    expect(await plugin.fallback("#执行B站任务",group)).toBe("订阅存储未连接。")
  } finally { await plugin.dispose() }
})

test("Milky 订阅管理仅接受宿主核验的当前会话主人",async()=>{
  const root=await directory()
  const provider={id:"bilibili",label:"B站",typeNames:biliTypes,profile:async uid=>({uid,name:"公开昵称"})}
  const plugin=await createSubscriptionModule({lockFile,groups:{}},{directory:root,providers:{bilibili:provider},getRedis:()=>undefined})
  try {
    const owner={adapter:"milky",self_id:98,user_id:42,message_type:"private",isMaster:false,isBotMaster:user=>user===42}
    const add="#添加B站推送 " + uid
    expect(await plugin.fallback(add,{...owner,user_id:43,isMaster:true})).toContain("主人")
    expect(await plugin.fallback(add,{...owner,isDelegated:true})).toContain("主人")
    expect(await plugin.fallback(add,{...owner,adapter:undefined})).toContain("主人")
    expect(await plugin.fallback(add,owner)).toContain("公开昵称")
    expect(await plugin.fallback("#B站全部订阅列表",owner)).toMatchObject({type:"forward",nodes:[expect.stringContaining("公开昵称")]})
    expect(await plugin.fallback("#执行B站任务",owner)).toBe("订阅存储未连接。")
  } finally { await plugin.dispose() }
})

test("全部订阅列表只列聊天所在机器人，授权终端可核对全部",async()=>{
  const root=await directory()
  const dir=join(root,"yuki-plugin","config","bilibili")
  await mkdir(dir,{recursive:true})
  await writeFile(join(dir,"push.yaml"),YAML.stringify({
    group:{77:[{bot_id:99,uid,name:"OneBot 群订阅",type:[draw]},{bot_id:98,uid,name:"Milky 群订阅",type:[]}]},
    private:{42:[{bot_id:98,uid,name:"Milky 私聊订阅",type:[article]}]},
  }))
  const provider={id:"bilibili",label:"B站",typeNames:biliTypes}
  const plugin=await createSubscriptionModule({lockFile,groups:{}},{directory:root,providers:{bilibili:provider},getRedis:()=>undefined})
  try {
    const command="/B站全部推送列表"
    const oneBot={self_id:99,user_id:42,group_id:77,message_type:"group",isMaster:true}
    const milky={adapter:"milky",self_id:98,user_id:42,message_type:"private",isMaster:false,isBotMaster:id=>id===42}
    expect(await plugin.fallback(command,oneBot)).toEqual({type:"forward",nodes:[
      `群 77 · 机器人 99\n${uid}：OneBot 群订阅 [图文]`,
    ]})
    expect(await plugin.fallback(command,milky)).toEqual({type:"forward",nodes:[
      `群 77 · 机器人 98\n${uid}：Milky 群订阅 [全部动态]`,
      `私聊 42 · 机器人 98\n${uid}：Milky 私聊订阅 [文章]`,
    ]})
    expect(await plugin.fallback(command,{...oneBot,self_id:undefined})).toMatch(/查询当前会话/u)
    expect(await plugin.fallback(command,{...oneBot,self_id:97})).toMatch(/当前没有订阅/u)
    const terminal=await plugin.fallback(command,{message_type:"terminal",isMaster:true})
    expect(terminal.nodes).toHaveLength(3)
    expect(await plugin.fallback(command,{message_type:"terminal",isMaster:false})).toMatch(/只有机器人主人/u)
  } finally { await plugin.dispose() }
})

test("媒体帮助只展示当前指令，停用原插件品牌前缀",async()=>{
  const root=await directory()
  const stub=()=>renderSubscriptionHelp(async()=>{ throw new Error("fixture render unavailable") })
  const plugin=await createSubscriptionModule({lockFile,groups:{}},{directory:root,providers:{},getRedis:()=>undefined,renderHelp:stub})
  try {
    const user={self_id:99,user_id:42,message_type:"private",isMaster:false}
    const help=await plugin.fallback("#媒体帮助",user)
    expect(help.type).toBe("text")
    expect(help.text).toContain("#B站订阅列表")
    expect(help.text).toContain("#执行微博任务")
    expect(help.text).toContain("直接发送视频链接")
    expect(help.text).not.toMatch(/扫码|Cookie|优纪|yuki/iu)
    expect(await plugin.fallback("/媒体帮助",user)).toEqual(help)
    for (const command of ["#优纪帮助","/优纪帮助","#yuki帮助","/YUKI帮助"]) {
      expect(await plugin.fallback(command,user)).toBeUndefined()
    }
    expect(await plugin.fallback("#帮助",user)).toBeUndefined()
    expect(await renderSubscriptionHelp(async()=>({png:Buffer.from([1])}))).toEqual({type:"image",file:Buffer.from([1])})
  } finally { await plugin.dispose() }
})

test("B站旧查人指令保留开放资料、搜索粉丝数和规范直播间链接",async()=>{
  const root=await directory()
  const paths=[]
  const provider=createBiliProvider({fetch:async (url,init)=>{
    paths.push(url.pathname)
    expect(init.credentials).toBe("omit")
    if (url.pathname === "/x/web-interface/card") return Response.json({code:0,data:{follower:0,card:{
      mid:uid,name:"公开昵称",sex:"保密",level_info:{current_level:6},attention:60,sign:"[CQ:at,qq=all]",
      live_room:{roomid:12,title:"公开直播",liveStatus:0,watched_show:{num:0},url:"https://fixture.invalid/"},
    }}})
    return Response.json({code:0,data:{result:[null,{mid:uid,uname:'<em class="keyword">公开</em>昵称',fans:123},
      {mid:123,uname:"另一账号",fans:"未知"},
    ]}})
  }})
  const plugin=await createSubscriptionModule({lockFile,groups:{}},{directory:root,providers:{bilibili:provider},getRedis:()=>undefined})
  try {
    const group={self_id:99,user_id:40,group_id:77,message_type:"group",isMaster:false}
    expect(await plugin.fallback("/优纪B站UP主UID:"+uid,group)).toBeUndefined()
    expect(await plugin.fallback("#yukiB站UP主昵称：公开",group)).toBeUndefined()
    expect(await plugin.fallback("/B站UP主UID:"+uid,group)).toEqual([{type:"text",text:["公开昵称 · UID "+uid,
      "性别：保密","等级：6","粉丝数：0","关注数：60","[CQ:at,qq=all]","直播间：公开直播","直播状态：未开播",
      "观看人数：0","直播链接：https://live.bilibili.com/12"].join("\n")}])
    expect(await plugin.fallback("#B站UP主昵称：公开",group)).toEqual([{type:"text",text:
      `公开昵称 · UID ${uid}\n粉丝数：123\n\n另一账号 · UID 123`}])
    expect(paths).toEqual(["/x/web-interface/card","/x/web-interface/search/type"])
  } finally { await plugin.dispose() }
})

test("订阅去重沿用群或私聊旧键，并排除过期、转发、关键词和同群多机器人重复",async()=>{
  const confirmed=[]
  const kv=new Map()
  const legacy=receiptKey("bilibili",route,{id:"already"})
  kv.set(legacy,"1")
  const redis=mockReceipts(kv)
  const posts = (id,options={})=>({id,uid,type:draw,createdAt:seen,content:"准入",...options})
  let fetched=0
  const provider={id:"bilibili",label:"B站",fetchPosts:async()=>{
    fetched++
    return [posts("already"),posts("fresh"),posts("old",{createdAt:seen-7300}),posts("blocked",{content:"准入屏蔽"}),
      posts("forward",{type:"DYNAMIC_TYPE_FORWARD"}),posts("other",{content:"其他"})]
  }}
  const d=createSubscriptionDelivery({providers:{bilibili:provider},
    config:{settings:async()=>settingsFor({pushTransmit:0,whiteWordslist:["准入"],banWords:["屏蔽"],pushTaskLog:0}),
      routes:async()=>[route,{...route,bot:"98"}]},
    groups:{onlineBots:()=>[98,99],listGroups:async()=>[{id:77}],sendGroup:async(bot,group,text)=>{confirmed.push([bot,group,text]);return 123}},
    getRedis:()=>redis,now:()=>seen*1000,render:async (_,post)=>[post.id],
  })
  try {
    const report=await d.run("bilibili")
    expect(confirmed).toEqual([[99,77,"fresh"]])
    expect(report.confirmed).toBe(1)
    expect(fetched).toBe(1)
    expect(kv.get(receiptKey("bilibili",route,{id:"fresh"}))).toBe("1")
    expect(receiptKey("weibo",{...route,kind:"private",chat:"42"},{id:"12233"})).toBe("Yz:yuki:weibo:upPush:private:42:12233")
  } finally { await d.dispose() }
})

test("订阅出图沿同一在线发送会话取得字节上限",async()=>{
  const friend={...route,kind:"private",chat:"42",bot:"98"}
  const note={id:"pictured",uid,type:draw,createdAt:seen,content:"正文",url:"https://t.bilibili.com/123"}
  const budgets=[], sent=[], redis=mockReceipts(new Map())
  const delivery=createSubscriptionDelivery({
    providers:{bilibili:{id:"bilibili",label:"B站",fetchPosts:async()=>[note]}},
    config:{settings:async()=>settingsFor({pushTaskLog:0}),routes:async()=>[route,friend]},
    notifications:()=>[
      {botId:99,inlineImageByteLimit:600000,isGroupMember:async()=>true,sendGroup:async(group,value)=>{
        sent.push([group,value]);return "confirmed"
      }},
      {botId:98,isFriend:async()=>true,sendPrivate:async(user,value)=>{
        sent.push([user,value]);return "confirmed"
      }},
    ],
    getRedis:()=>redis,now:()=>seen*1000,
    render:async(_,post,_settings,options)=>{budgets.push(options.inlineImageByteLimit);return [post.url]},
  })
  try {
    expect(await delivery.run("bilibili")).toMatchObject({confirmed:2})
    expect(budgets).toEqual([600000,undefined])
    expect(sent).toEqual([[77,note.url],[42,note.url]])
  } finally { await delivery.dispose() }
})

test("文字关键词检查转发与原帖链接，匹配屏蔽词时不写去重记录",async()=>{
  const kept={id:"12301",uid,type:"DYNAMIC_TYPE_FORWARD",createdAt:seen,title:"正文",
    url:"https://m.bilibili.com/dynamic/12301",forwarded:{url:"https://www.bilibili.com/read/cv456"}}
  const hidden={...kept,id:"12302",url:"https://m.bilibili.com/dynamic/12302",
    forwarded:{url:"https://www.bilibili.com/read/cv456?track=excluded"}}
  const provider={id:"bilibili",label:"B站",fetchPosts:async()=>[kept,hidden]}
  const kv=new Map(), confirmed=[]
  let picture=1
  const delivery=createSubscriptionDelivery({providers:{bilibili:provider},
    config:{settings:async()=>settingsFor({pushMsgMode:picture,whiteWordslist:["/read/cv456"],
      banWords:["?track=excluded"],pushTaskLog:0}),routes:async()=>[route]},
    groups:{onlineBots:()=>[99],listGroups:async()=>[{id:77}],sendGroup:async(bot,group,message)=>{
      confirmed.push(message)
      return 123
    }},
    getRedis:()=>mockReceipts(kv),now:()=>seen*1000,render:async(_,post)=>[post.id],
  })
  try {
    expect(await delivery.run("bilibili")).toMatchObject({confirmed:0})
    expect(kv.size).toBe(0)
    picture=0
    expect(await delivery.run("bilibili")).toMatchObject({confirmed:1})
    expect(confirmed).toEqual([kept.id])
    expect(kv.has(receiptKey("bilibili",route,hidden))).toBe(false)
  } finally { await delivery.dispose() }
})


function mockReceipts(kv) {
  return {
    get:async key=>kv.get(key) ?? null,
    set:async (key,value,{NX})=>{
      if (NX && kv.has(key)) return null
      kv.set(key,value)
      return "OK"
    },
    eval:async (script,{keys,arguments:args})=>{
      if (keys.length === 1) {
        const [token, state] = args
        if (kv.get(keys[0]) === token) {
          if (state === "rejected") kv.delete(keys[0])
          else kv.set(keys[0], "1")
        }
        return 1
      }
      if (script.includes("EXISTS")) {
        const claimed = []
        for (const [index, token] of args.slice(1).entries()) {
          const legacy = keys[index * 2], journal = keys[index * 2 + 1]
          if (kv.has(legacy) || kv.has(journal)) continue
          kv.set(legacy,token)
          kv.set(journal,token)
          claimed.push(index + 1)
        }
        return claimed
      }
      const [state, ...tokens] = args
      for (const [index, token] of tokens.entries()) {
        const legacy = keys[index * 2], journal = keys[index * 2 + 1]
        if (state === "rejected") {
          if (kv.get(legacy) === token) kv.delete(legacy)
          if (kv.get(journal) === token) kv.delete(journal)
        } else if (kv.get(journal) === token) {
          if (kv.get(legacy) === token) kv.set(legacy, "1")
          kv.set(journal, state)
        }
      }
      return 1
    },
  }
}

for (const change of ["移除订阅", "关闭自动推送"]) {
  test(`同一轮${change}后停止下一条动态，不重发已确认的动态`, async () => {
    const kv = new Map(), sent = []
    const first = Promise.withResolvers(), release = Promise.withResolvers()
    let routes = [route], enabled = true
    const provider = { id: "weibo", label: "微博", fetchPosts: async () => ["801", "802"].map((id, i) => ({
      id, uid, type: draw, createdAt: seen - 2 + i, content: "动态正文",
    })) }
    const delivery = createSubscriptionDelivery({ providers: { weibo: provider },
      config: { settings: async () => settingsFor({ getDataRandomDelay: 0, pushTaskLog: 0, pushStatus: enabled }), routes: async () => routes },
      notifications: () => [{ botId: 99, isGroupMember: async () => true, async sendGroup(_group, message) {
        sent.push(message)
        first.resolve()
        await release.promise
        return "confirmed"
      } }], getRedis: () => mockReceipts(kv), now: () => seen * 1000, render: async (_, post) => [post.id],
    })
    try {
      const running = delivery.run("weibo", true)
      await first.promise
      if (change === "移除订阅") routes = []
      else enabled = false
      release.resolve()
      expect(await running).toMatchObject({ confirmed: 1, skipped: 1, failed: 0 })
      expect(sent).toEqual(["801"])
      expect(kv.get(receiptKey("weibo", route, { id: "801" }))).toBe("1")
      expect(kv.has(receiptKey("weibo", route, { id: "802" }))).toBe(false)
      routes = [route]
      expect(await delivery.run("weibo")).toMatchObject({ confirmed: 1, skipped: 1 })
      expect(sent).toEqual(["801", "802"])
    } finally { release.resolve(); await delivery.dispose() }
  })
}

test("合并转发领取后撤销一条订阅，只发送仍获准的节点并释放撤销项占位", async () => {
  const kv = new Map(), sent = []
  const store = mockReceipts(kv), claim = store.eval
  const second = { ...route, uid: "372" }
  let routes = [route, second]
  store.eval = async (script, options) => {
    const result = await claim(script, options)
    if (script.includes("EXISTS") && options.keys.length === 4) routes = [route]
    return result
  }
  const provider = { id: "weibo", label: "微博", fetchPosts: async account => [
    { id: account, uid: account, type: draw, createdAt: seen - 2, content: "动态正文" },
  ] }
  const delivery = createSubscriptionDelivery({ providers: { weibo: provider },
    config: { settings: async () => settingsFor({ getDataRandomDelay: 0, pushTaskLog: 0, maxTextLengthForSingleMsg: 0 }),
      routes: async () => routes },
    notifications: () => [{ botId: 99, isGroupMember: async () => true,
      async sendForward(_target, nodes) { sent.push(nodes); return "confirmed" } }],
    getRedis: () => store, now: () => seen * 1000, render: async (_, post) => [post.id],
  })
  try {
    expect(await delivery.run("weibo")).toMatchObject({ confirmed: 1, skipped: 1, failed: 0 })
    expect(sent).toEqual([["有新的微博动态了~", [uid]]])
    expect(kv.get(receiptKey("weibo", route, { id: uid }))).toBe("1")
    expect(kv.has(receiptKey("weibo", second, { id: second.uid }))).toBe(false)
  } finally { await delivery.dispose() }
})

test("微博分别为账号查询与动态发送留间隔，零值关闭两段等待", async () => {
  const calls = []
  const second = { ...route, uid: "372" }
  let configuredDelay
  const provider = { id: "weibo", label: "微博", fetchPosts: async account => {
    calls.push(["fetch", account])
    return [{ id: account, uid: account, type: draw, createdAt: seen - 2, content: "动态正文" }]
  } }
  const delivery = createSubscriptionDelivery({ providers: { weibo: provider },
    config: { settings: async () => settingsFor({ getDataRandomDelay: configuredDelay, pushTaskLog: 0 }, "weibo"),
      routes: async () => [route, second] },
    notifications: () => [{ botId: 99, isGroupMember: async () => true, async sendGroup(_group, message) {
      calls.push(["send", message]); return "confirmed"
    } }], getRedis: () => mockReceipts(new Map()), now: () => seen * 1000, render: async (_, post) => [post.id],
    async wait(delay, signal) { expect(signal.aborted).toBe(false); calls.push(["wait", delay]) },
  })
  try {
    expect((await delivery.run("weibo")).confirmed).toBe(2)
    expect(calls.map(([name]) => name)).toEqual(["fetch", "wait", "fetch", "send", "wait", "send"])
    expect(calls[1][1]).toBeGreaterThanOrEqual(1_000)
    expect(calls[1][1]).toBeLessThanOrEqual(4_000)
    expect(calls[4][1]).toBeGreaterThanOrEqual(1_000)
    expect(calls[4][1]).toBeLessThanOrEqual(2_000)
    configuredDelay = 0
    calls.length = 0
    expect((await delivery.run("weibo")).confirmed).toBe(2)
    expect(calls.map(([name]) => name)).toEqual(["fetch", "fetch", "send", "send"])
  } finally { await delivery.dispose() }
})

test("B站直播全员提醒沿用旧群冷却和失败开关，提醒失败不影响动态",async()=>{
  const kv=new Map(), calls=[]
  const group88={...route,chat:"88"}, friend={...route,chat:"42",kind:"private"}
  const mark="Yz:yuki:bili:upPush:group:77:liveAtAllMark"
  const keyFor=id=>receiptKey("bilibili",route,{id})
  let decision="rejected", warn, id="1"
  const provider={id:"bilibili",label:"B站",fetchPosts:async()=>[
    {id,uid,createdAt:seen,type:"DYNAMIC_TYPE_LIVE_RCMD",content:"直播"},
  ]}
  const delivery=createSubscriptionDelivery({providers:{bilibili:provider},
    config:{settings:async()=>settingsFor({liveAtAll:1,liveAtAllGroupList:[77,42],liveAtAllErrMsg:warn,pushTaskLog:0}),
      routes:async()=>[route,group88,friend]},
    notifications:()=>[{botId:99,isGroupMember:async()=>true,isFriend:async()=>true,
      sendGroup:async (group,payload)=>{
        calls.push([group,payload])
        return Array.isArray(payload) ? decision : "confirmed"
      },sendPrivate:async (user,payload)=>{calls.push([user,payload]);return "confirmed"},
    }],
    getRedis:()=>mockReceipts(kv),now:()=>seen*1000,render:async (_,post)=>["动态 "+post.id],
  })
  try {
    expect((await delivery.run("bilibili")).confirmed).toBe(3)
    expect(calls[0]).toEqual([77,[{type:"at",qq:"all"}," B站 直播提醒"]])
    expect(calls[1]).toEqual([77,"直播动态发送@全体成员失败，请检查权限或平台是否支持"])
    expect(calls.slice(2)).toEqual([[77,"动态 1"],[88,"动态 1"],[42,"动态 1"]])
    expect(kv.has(mark)).toBe(false)
    expect(kv.get(keyFor("1"))).toBe("1")
    warn=0;id="2";calls.length=0
    await delivery.run("bilibili")
    expect(calls).toHaveLength(4)
    expect(kv.has(mark)).toBe(false)
    decision="unknown";id="3";calls.length=0
    await delivery.run("bilibili")
    expect(calls).toHaveLength(4)
    expect(kv.get(mark)).toBe("1")
    decision="confirmed";id="4";calls.length=0
    await delivery.run("bilibili")
    expect(calls).toEqual([[77,"动态 4"],[88,"动态 4"],[42,"动态 4"]])
  } finally { await delivery.dispose() }
})

test("沿用旧严格阈值，按会话累计文字和图数",()=>{
  const settings=settingsFor({})
  const img={type:"image",file:"https://i0.hdslb.com/demo.png"}
  const first={payloads:[["A".repeat(150),img]]}
  const second={payloads:[["B".repeat(150),img]]}
  expect(useDynamicForward([first,second],settings)).toBe(false)
  expect(useDynamicForward([first,second,{payloads:[img]}],settings)).toBe(true)
  expect(useDynamicForward([first,second,{payloads:["C"]}],settings)).toBe(true)
  expect(useDynamicForward([first,second,{payloads:[img]}],settingsFor({forwardSendDynamic:0}))).toBe(false)
})

for (const [decision,expected,groups] of [["confirmed","confirmed",0],["rejected","confirmed",2],["unknown","unknown",0]]) {
  test("后台长动态合并转发结果 "+decision+" 决定是否改用单条",async()=>{
    const kv=new Map(), calls=[]
    const second={...route,uid:"4051"}
    const provider={id:"bilibili",label:"B站",fetchPosts:async user=>[
      {id:"post-"+user,uid:user,type:draw,createdAt:user===uid?seen:seen-1,content:"批准"},
    ]}
    const delivery=createSubscriptionDelivery({
      providers:{bilibili:provider},
      config:{settings:async()=>settingsFor({getDataRandomDelay:0,pushTaskLog:0}),
        routes:async()=>[route,second]},
      notifications:()=>[{
        botId:99,
        isGroupMember:async (group,bot)=>group===77&&bot===99,
        sendGroup:async (group,payload)=>{calls.push(["group",group,payload]);return "confirmed"},
        sendForward:async (target,nodes)=>{calls.push(["forward",target,nodes]);return decision},
      }],
      getRedis:()=>mockReceipts(kv),now:()=>seen*1000,
      render:async (_,post)=>[[post.id,"传输内容".repeat(65)]],
    })
    try {
      const record=await delivery.run("bilibili")
      expect(record[expected]).toBe(2)
      expect(calls.filter(call=>call[0]==="group")).toHaveLength(groups)
      expect(calls[0]).toMatchObject(["forward",{groupId:77},["有新的B站动态了~",
        ["post-4051","传输内容".repeat(65)],["post-"+uid,"传输内容".repeat(65)]]])
      expect((await delivery.run("bilibili")).skipped).toBe(2)
      expect(calls.filter(call=>call[0]==="forward")).toHaveLength(1)
      expect(kv.get("lotus-yunzai:media:subscription:bilibili:group:77:post-"+uid)).toBe(expected)
      expect(kv.get(receiptKey("bilibili",route,{id:"post-"+uid}))).toBe("1")
    } finally { await delivery.dispose() }
  })
}

for (const withForward of [false, true]) {
  test(`动态${withForward ? "明确拒转后" : "逐条"}发送的回执异常保留当前项，后续动态仍可补发`,async()=>{
    const kv = new Map(), direct = [], forward = []
    const store = mockReceipts(kv)
    const evalReceipt = store.eval
    const one = "92011", two = "92012"
    const legacy = id => receiptKey("weibo", route, {id})
    const journal = id => "lotus-yunzai:media:subscription:weibo:group:77:" + id
    let firstFail = true
    store.eval = async (script, operation) => {
      if (firstFail && operation.arguments[0] === "confirmed" && operation.keys.includes(journal(one))) {
        firstFail = false
        expect(kv.has(journal(two))).toBe(false)
        expect(kv.has(legacy(two))).toBe(false)
        throw new Error("合成回执结算失败")
      }
      return evalReceipt(script, operation)
    }
    const provider = { id:"weibo", label:"微博", fetchPosts:async()=>[one,two].map((id,i)=>({
      id, uid, type:draw, createdAt:seen-3+i, content:"原动态",
    })) }
    const sender = { botId:99, isGroupMember:async()=>true, sendGroup:async(_gid,payload)=>{
      direct.push(payload[0])
      return "confirmed"
    }}
    if (withForward) sender.sendForward = async (_target, nodes) => {
      forward.push(nodes.slice(1).map(node=>node[0]))
      return "rejected"
    }
    const makeDelivery = () => createSubscriptionDelivery({
      providers:{weibo:provider}, config:{settings:async()=>settingsFor({pushTaskLog:0,getDataRandomDelay:0}),
        routes:async()=>[route]}, notifications:()=>[sender], getRedis:()=>store, now:()=>seen*1000,
      render:async(_,post)=>[[post.id,"正文".repeat(100)]],
    })
    const first = makeDelivery()
    try {
      expect((await first.run("weibo")).failed).toBe(1)
      expect(direct).toEqual([one])
      expect(kv.get(journal(one))).toMatch(/^pending:/u)
      expect(kv.has(journal(two))).toBe(false)
    } finally { await first.dispose() }
    const second = makeDelivery()
    try {
      expect(await second.run("weibo")).toMatchObject({confirmed:1, skipped:1, failed:0})
      expect(direct).toEqual([one,two])
      expect(forward).toEqual(withForward ? [[one,two]] : [])
      expect(await second.run("weibo")).toMatchObject({confirmed:0, skipped:2})
    } finally { await second.dispose() }
  })
}

test("合并转发结算异常只占这一批，下一批动态仍能补发",async()=>{
  const kv = new Map(), forward = []
  const store = mockReceipts(kv)
  const evalReceipt = store.eval
  const posts = Array.from({length:100},(_,i)=>({id:String(83000+i),uid,type:draw,createdAt:seen-200+i,content:"合成图文"}))
  const tail = "lotus-yunzai:media:subscription:weibo:group:77:" + posts.at(-1).id
  let fail = true
  store.eval = async (script, op) => {
    if (fail && op.arguments[0] === "confirmed") {
      fail = false
      expect(op.keys).toHaveLength(198)
      expect(kv.has(tail)).toBe(false)
      throw new Error("合成批次结算失败")
    }
    return evalReceipt(script, op)
  }
  const delivery = createSubscriptionDelivery({providers:{weibo:{id:"weibo",label:"微博",fetchPosts:async()=>posts}},
    config:{settings:async()=>settingsFor({pushTaskLog:0,getDataRandomDelay:0}),routes:async()=>[route]},
    notifications:()=>[{botId:99,isGroupMember:async()=>true,
      sendForward:async(_target,nodes)=>{forward.push(nodes.length-1);return "confirmed"},
      sendGroup:async()=>{throw new Error("应使用合并转发")}}],
    getRedis:()=>store, now:()=>seen*1000,render:async(_,post)=>[[post.id,"正文".repeat(180)]],
  })
  try {
    expect(await delivery.run("weibo")).toMatchObject({failed:1, confirmed:0})
    expect(forward).toEqual([99])
    expect(kv.has(tail)).toBe(false)
    expect(await delivery.run("weibo")).toMatchObject({confirmed:1, skipped:99, failed:0})
    expect(forward).toEqual([99,1])
  } finally { await delivery.dispose() }
})

test("动态领取回包异常按同一 token 清理部分写入，保留其他进程落盘",async()=>{
  const kv = new Map(), direct = []
  const store = mockReceipts(kv)
  const evalReceipt = store.eval
  const posts = [1,2].map(i=>({id:"claim-"+i,uid,type:draw,createdAt:seen-4+i,content:"合成图文"}))
  let fail = true
  store.eval = async (script, op) => {
    if (fail && script.includes("EXISTS")) {
      fail = false
      kv.set(op.keys[0],op.arguments[1])
      kv.set(op.keys[1],"另一进程的已确认标记")
      throw new Error("合成领取回包异常")
    }
    return evalReceipt(script, op)
  }
  const delivery = createSubscriptionDelivery({providers:{weibo:{id:"weibo",label:"微博",fetchPosts:async()=>posts}},
    config:{settings:async()=>settingsFor({pushTaskLog:0,getDataRandomDelay:0}),routes:async()=>[route]},
    notifications:()=>[{botId:99,isGroupMember:async()=>true,sendGroup:async(_gid,payload)=>{direct.push(payload);return "confirmed"}}],
    getRedis:()=>store, now:()=>seen*1000,render:async(_,post)=>[post.id],
  })
  try {
    expect((await delivery.run("weibo")).failed).toBe(1)
    expect(direct).toEqual([])
    expect(kv.has(receiptKey("weibo",route,posts[0]))).toBe(false)
    expect(kv.get("lotus-yunzai:media:subscription:weibo:group:77:claim-1")).toBe("另一进程的已确认标记")
    expect(kv.has(receiptKey("weibo",route,posts[1]))).toBe(false)
    expect(await delivery.run("weibo")).toMatchObject({confirmed:1, skipped:1, failed:0})
    expect(direct).toEqual(["claim-2"])
  } finally { await delivery.dispose() }
})
