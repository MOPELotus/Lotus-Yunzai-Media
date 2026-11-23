import { expect, test } from "bun:test"
import { createBilibiliVideoCommands } from "../services/bilibili/video-command.ts"
import { settingsFor } from "../services/subscriptions/config.ts"

const postUrl = "https://t.bilibili.com/12234455"
const oid = "1252946018760130569"
const imageUrl = "https://i0.hdslb.com/bfs/new_dyn/comment.png"
const bytes = Uint8Array.of(1, 3, 5)

function comment(rpid, name, text, like = 0, fields = {}) {
  return { oid_str: oid, type: 11, rpid_str: String(rpid), like, member: { uname: name }, content: { message: text }, ...fields }
}

test("引用确认送达的 B 站动态按原先显示序号展开评论和子评论", async () => {
  const requests = []
  const cards = []
  const messages = []
  const controller = new AbortController()
  let enabled = true
  let ack = true
  let altered = false
  let privatePost = false
  const main = comment(800, "第一热评", "第一热评完整正文", 20)
  const pinned = comment(801, "置顶作者", "置顶内容", 1)
  const api = createBilibiliVideoCommands({ signal: controller.signal,
    settings: async () => settingsFor({ parseVideoLink: enabled, pushMsgMode: 0 }),
    async renderComments(card) { cards.push(card); return Buffer.from(bytes) },
    async fetch(input, options) {
      const url = new URL(input)
      requests.push(url)
      expect(options.credentials).toBe("omit")
      expect(options.redirect).toBe("error")
      expect(new Headers(options.headers).has("Cookie")).toBe(false)
      if (url.href === imageUrl) return new Response(bytes, { headers: { "Content-Type": "image/png" } })
      if (url.pathname === "/x/polymer/web-dynamic/v1/detail") return Response.json({ code: 0, data: { item: {
        id_str: "12234455", type: "DYNAMIC_TYPE_WORD", basic: { comment_id_str: oid, comment_type: 11, is_only_fans: privatePost }, modules: {
          module_author: { mid: "3009", name: "测试作者", pub_ts: 1700000000 },
          module_dynamic: { desc: { text: "测试原帖" } }, module_stat: { comment: { count: 9 } },
        },
      } } })
      expect(url.searchParams.get("oid")).toBe(oid)
      expect(url.searchParams.get("type")).toBe("11")
      if (url.pathname === "/x/v2/reply") return Response.json({ code: 0, data: {
        upper: { top: pinned }, replies: [pinned, comment(802, "第二热评", "第二热评", 10), altered ? comment(999, "被替换", "新内容", 99) : main],
      } })
      expect(url.pathname).toBe("/x/v2/reply/reply")
      expect(url.searchParams.get("root")).toBe("800")
      return Response.json({ code: 0, data: { root: main, replies: [
        comment(910, "第一条子回复", "子回复全文", 1, { root_str: "800" }),
        comment(911, "第二条子回复", "", 100, { root_str: "800", content: { pictures: [{ img_src: imageUrl }, { img_src: "https://outside.example/forged.png" }] } }),
        comment(912, "异楼", "不属于这一层", 200, { root_str: "799" }),
      ] } })
    },
  })
  const event = { message_type: "group", group_id: 55, self_id: 99, user_id: 42,
    reply: async (message, _, options) => {
      messages.push(message)
      if (ack) await options?.onDelivered?.(messages.length)
      return true
    },
  }
  const quote = (id, actor = 99) => ({ ...event, reply_id: id, lookupReply: async () => ({ user_id: actor, message: [{ type: "image" }] }) })
  try {
    expect(await api.fallback(postUrl, event)).toEqual([])
    expect(cards[0].items.map(item => item.label)).toEqual(["1. 置顶作者 · 置顶", "2. 第一热评", "3. 第二热评"])
    const listId = messages.length
    const before = requests.length
    expect(await api.fallback("展开 2", { ...quote(listId), adapter: "milky" })).toBeUndefined()
    expect(await api.fallback("展开 2", { ...quote(listId), group_id: 56 })).toBeUndefined()
    expect(await api.fallback("展开 2", quote(listId, 42))).toBeUndefined()
    expect(await api.fallback("展开 2", { ...quote(listId), isDelegated: true })).toBeUndefined()
    expect(await api.fallback("展开 9", quote(listId))).toContain("1–3")
    expect(requests).toHaveLength(before)
    enabled = false
    expect(await api.fallback("展开 2", quote(listId))).toBeUndefined()
    expect(requests).toHaveLength(before)
    enabled = true
    altered = true
    expect(await api.fallback("展开+2", quote(listId))).toEqual([])
    expect(requests).toHaveLength(before + 1)
    expect(cards[1].message).toContain("第一热评完整正文")
    expect(cards[1].items.map(item => item.value)).toEqual(["子回复全文", "[图片]"])
    const threadId = messages.length
    expect(await api.fallback("展开", quote(threadId))).toEqual([])
    expect(cards[2].message).toContain("子回复全文")
    expect(requests).toHaveLength(before + 1)
    expect(await api.fallback("展开 2", quote(threadId))).toEqual([])
    expect(requests.at(-1).href).toBe(imageUrl)
    expect(messages.at(-1)).toMatchObject({ type: "image", file: Buffer.from(bytes) })

    ack = false
    expect(await api.fallback(postUrl, event)).toEqual([])
    const unconfirmed = requests.length
    expect(await api.fallback("展开 2", quote(messages.length))).toBeUndefined()
    expect(requests).toHaveLength(unconfirmed)
    privatePost = true
    expect(await api.fallback(postUrl, event)).toEqual([])
    expect(requests).toHaveLength(unconfirmed + 1)
    expect(requests.at(-1).pathname).toBe("/x/polymer/web-dynamic/v1/detail")
  } finally { await api.dispose() }
})

test("引用 B 站视频的预览用 AV 号和评论类型 1；上游串楼禁止展示", async () => {
  const bv = "BV17x411w7KC"
  const url = `https://www.bilibili.com/video/${bv}`
  const paths = []
  const cards = []
  const post = { oid: 170001, type: 1, rpid_str: "574643211137318477", content: { message: "测试视频评论" } }
  const api = createBilibiliVideoCommands({
    settings: async () => settingsFor({ parseVideoLink: true }),
    async renderComments(card) { cards.push(card); return Buffer.from(bytes) },
    async fetch(input, options) {
      const target = new URL(input)
      paths.push(target.pathname)
      if (target.pathname.startsWith("/v1/videos/")) return Response.json({ ok: true, data: target.pathname.endsWith("/parts")
        ? [] : { video: { ref: `bilibili:bvid:${bv}`, title: "测试视频", extensions: { bvid: bv, aid: "170001", comment_count: 1 } } } })
      expect(options.credentials).toBe("omit")
      expect(target.searchParams.get("oid")).toBe("170001")
      expect(target.searchParams.get("type")).toBe("1")
      if (target.pathname === "/x/v2/reply") return Response.json({ code: 0, data: { replies: [post] } })
      expect(target.searchParams.get("root")).toBe(post.rpid_str)
      return Response.json({ code: 0, data: { root: { ...post, oid: 170002 }, replies: [post] } })
    },
  })
  let id = 0
  const context = { message_type: "private", self_id: 99, user_id: 42, reply_id: 1,
    lookupReply: async () => ({ user_id: 42, message: [{ type: "json", data: JSON.stringify({ meta: { news: { jumpUrl: url } } }) }] }),
    reply: async (_, quoted, options) => { await options?.onDelivered?.(++id); return true },
  }
  try {
    expect(await api.fallback("解析", context)).toEqual([])
    expect(cards[0].items[0].value).toBe("测试视频评论")
    expect(await api.fallback("#展开 1", { ...context, reply_id: id,
      lookupReply: async () => ({ user_id: 99, message: [{ type: "image" }] }) })).toContain("子评论暂不可用")
    expect(cards).toHaveLength(1)
    expect(paths.slice(-2)).toEqual(["/x/v2/reply", "/x/v2/reply/reply"])
  } finally { await api.dispose() }
})
