import { expect, test } from "bun:test"
import { CommandRegistry } from "../../../lib/commands.ts"
import { createBilibiliVideoCommands } from "../services/bilibili/video-command.ts"
import { settingsFor } from "../services/subscriptions/config.ts"

const uid = "4200"
const video = "BV17x411w7KC"
const csrf = "0123456789abcdef0123456789abcdef"
const dynamic = "1252946018760130569"
const oid = "410579354"
const appSessionKey = "Yz:yuki:bili:cookie:.bilibili.com:"
const commentKey = "lotus:media:bili-comment:"

function fixture() {
  const calls = []
  const db = new Map()
  const ui = []
  const auth = { enabled: true, owner: true, account: uid, writeMode: "ok", privatePost: false,
    current: true, metadata: true, onProfile: () => {}, onClaim: () => {} }
  const connection = new AbortController()
  const login = () => {
    db.set(appSessionKey + "SESSDATA", "synthetic-session")
    db.set(appSessionKey + "bili_jct", csrf)
    db.set(appSessionKey + "DedeUserID", uid)
  }
  const redis = { async get(key) { return db.get(key) ?? null },
    async mGet(keys) { return keys.map(key => db.get(key) ?? null) },
    async set(key, value, options) {
      expect(options.NX).toBe(true)
      if (db.has(key)) return null
      db.set(key, value)
      if (key.startsWith(commentKey)) auth.onClaim()
      return "OK"
    },
    async eval(_, { keys }) { db.delete(keys[0]); return 1 },
  }
  const options = { getRedis: () => auth.current ? redis : undefined,
    settings: async () => settingsFor({ parseVideoLink: auth.enabled, pushMsgMode: 0 }),
    async fetch(input, init) {
      const url = new URL(input)
      const path = url.pathname
      const headers = new Headers(init.headers)
      expect(init.credentials).toBe("omit")
      expect(init.redirect).toBe("error")
      calls.push({ path, method: init.method ?? "GET", query: url.search, body: init.body })
      if (path === "/x/polymer/web-dynamic/v1/detail") {
        expect(headers.has("Cookie")).toBe(false)
        expect(url.searchParams.get("id")).toBe(dynamic)
        return Response.json({ code: 0, data: { item: { id_str: dynamic, type: "DYNAMIC_TYPE_WORD", modules: {
          module_author: { mid: "991", name: "测试账号", pub_ts: 1700000000 },
        }, basic: { comment_id_str: oid, comment_type: 11, is_only_fans: auth.privatePost } } } })
      }
      if (path === "/x/web-interface/view") {
        expect(headers.has("Cookie")).toBe(false)
        expect(url.searchParams.get("bvid")).toBe(video)
        return Response.json({ code: 0, data: { bvid: auth.metadata ? video : "BV1qS411m73i", aid: "170001" } })
      }
      expect(url.origin).toBe("https://api.bilibili.com")
      expect(headers.get("Cookie")).toBe(`SESSDATA=synthetic-session; bili_jct=${csrf}; DedeUserID=${uid}`)
      if (path === "/x/web-interface/nav") {
        auth.onProfile()
        return Response.json({ code: 0, data: { isLogin: true, mid: auth.account } })
      }
      expect(path).toBe("/x/v2/reply/add")
      expect(init.method).toBe("POST")
      expect(url.search).toBe("")
      expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded")
      expect(init.body.get("csrf")).toBe(csrf)
      if (auth.writeMode === "unknown") throw new Error("合成网络断开")
      if (auth.writeMode === "closed") return Response.json({ code: 12002 })
      return Response.json({ code: 0, data: { reply: { rpid_str: "80010000000000345", mid_str: auth.writeMode === "wrong-uid" ? "4500" : uid,
        oid_str: init.body.get("oid"), type: Number(init.body.get("type")) } } })
    },
  }
  let command = createBilibiliVideoCommands(options)
  const scope = { message_type: "group", group_id: 88, self_id: 99, user_id: 42, message_id: 17, reply_id: 1,
    isBotMaster: user => auth.owner && user === 42, groupActivitySignal: connection.signal,
    reply: async (message, _, options) => { ui.push(message); await options?.onDelivered?.(31); return true },
    lookupReply: async () => ({ user_id: 7, message: [{ type: "json", data: JSON.stringify({ meta: { news: { jumpUrl: `https://www.bilibili.com/video/${video}` } } }) }] }),
  }
  const call = (message, overrides) => command.fallback(message, { ...scope, ...overrides })
  const postCalls = () => calls.filter(call => call.method === "POST")
  return { auth, calls, call, login, db, postCalls, connection, get command() { return command }, scope,
    async reopen() { await command.dispose(); command = createBilibiliVideoCommands(options) } }
}

test("B 站主人评论按经验证的引用视频发单次表单，原消息重放在重启后也不会重发", async () => {
  const f = fixture()
  try {
    f.login()
    const commands = new CommandRegistry()
    commands.registerModule({ name: "@lotus-yunzai/media", commands: {}, fallback: f.command.fallback, fallbackFeatures: f.command.features })
    const event = { ...f.scope, msg: "评论 你好 & #问候\n下一行" }
    expect(await commands.dispatchFallback(event, names => !names.includes("[media] B 站解析"), f.scope.isBotMaster)).toBeUndefined()
    expect(f.calls).toHaveLength(0)
    expect(await commands.dispatchFallback(event, () => true, f.scope.isBotMaster)).toContain("80010000000000345")
    expect(f.calls.map(call => call.path)).toEqual(["/x/web-interface/view", "/x/web-interface/nav", "/x/v2/reply/add"])
    expect(f.postCalls()).toHaveLength(1)
    expect(Object.fromEntries(f.postCalls()[0].body)).toEqual({ message: "你好 & #问候\n下一行", oid: "170001", type: "1", csrf })
    await f.reopen()
    expect(await f.call("评论 另一个正文")).toContain("已经处理")
    expect(f.calls).toHaveLength(3)
    expect([...f.db].filter(([key]) => key.startsWith(commentKey)).map(([, value]) => value)).toEqual(["claimed"])
    expect(await f.call("#评论 不同协议", { adapter: "milky" })).toContain("已发送")
    expect(f.postCalls()).toHaveLength(2)
    expect(f.calls[0].query).toContain(video)
    expect(f.calls[2].query).toBe("")
  } finally { await f.command.dispose() }
})

test("动态从原会话确认预览定位，未知结果无重发，非主人、目标更换及授权范围不出站", async () => {
  const f = fixture()
  const direct = `https://www.bilibili.com/opus/${dynamic}`
  try {
    f.login()
    expect(await f.call(direct)).toEqual([])
    const reference = { reply_id: 31,
      lookupReply: async () => ({ user_id: f.scope.self_id, message: [{ type: "image" }] }) }
    const before = f.calls.length
    f.auth.owner = false
    expect(await f.call("评论 访客", reference)).toBeUndefined()
    f.auth.owner = true
    expect(await f.call("评论 代操作", { ...reference, isDelegated: true })).toBeUndefined()
    expect(await f.call("评论 同号其他协议", { ...reference, adapter: "milky" })).toBeUndefined()
    expect(await f.call("评论 其他群", { ...reference, group_id: 89 })).toBeUndefined()
    expect(f.calls).toHaveLength(before)
    f.auth.writeMode = "unknown"
    expect(await f.call("评论 测试动态", reference)).toContain("结果未确认")
    expect(f.postCalls()).toHaveLength(1)
    expect(f.postCalls()[0].body.get("oid")).toBe(oid)
    expect(f.postCalls()[0].body.get("type")).toBe("11")
    expect(await f.call("评论 测试动态", reference)).toContain("已经处理")
    expect(f.postCalls()).toHaveLength(1)
    f.auth.privatePost = true
    expect(await f.call("评论 粉丝帖", { ...reference, message_id: 20 })).toContain("无法确认")
    expect(f.postCalls()).toHaveLength(1)
  } finally { await f.command.dispose() }
})

test("B 站发评论需要现用独立登录，写前复核账号、权限、连接和回执身份", async () => {
  const f = fixture()
  try {
    expect(await f.call("评论 未登录")).toContain("独立的 B 站动态登录")
    f.login()
    f.db.set(appSessionKey + "SESSDATA:meta", '{"path":"/x/polymer"}')
    expect(await f.call("评论 路径受限")).toContain("独立的 B 站动态登录")
    f.db.delete(appSessionKey + "SESSDATA:meta")
    f.auth.metadata = false
    expect(await f.call("评论 错视频")).toContain("无法确认")
    f.auth.metadata = true
    f.auth.account = "4500"
    expect(await f.call("评论 错身份")).toContain("身份无法确认")
    f.auth.account = uid
    f.auth.onProfile = () => { f.auth.owner = false }
    expect(await f.call("评论 撤销主人")).toBeUndefined()
    f.auth.owner = true
    f.auth.onProfile = () => {}
    f.auth.onClaim = () => { f.db.set(appSessionKey + "bili_jct", "replacement-replacement") }
    expect(await f.call("评论 换账号")).toContain("登录已变更")
    expect(f.postCalls()).toHaveLength(0)
    f.login()
    f.auth.onClaim = () => {}
    f.auth.writeMode = "wrong-uid"
    expect(await f.call("评论 回执不符", { message_id: 22 })).toContain("结果未确认")
    f.auth.writeMode = "closed"
    expect(await f.call("评论 上游明确关闭", { message_id: 30 })).toContain("已关闭")
    f.auth.onProfile = () => { f.connection.abort() }
    expect(await f.call("评论 原会话断开", { message_id: 25 })).toBeUndefined()
    expect(f.postCalls()).toHaveLength(2)
  } finally { await f.command.dispose() }
})
