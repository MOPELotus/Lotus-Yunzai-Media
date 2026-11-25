import { expect, test } from "bun:test"
import { createWeixinChannelsPreview } from "../services/weixin-channels/preview.ts"
const id = "AzGrUgqzFv"
const share = "https://weixin.qq.com/sph/" + id
const page = "https://channels.weixin.qq.com/finder-preview/pages/sph?id=" + id
const api = "https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info"
const context = { normalizedMessage: share, message_type: "group" as const, group_id: 55, self_id: 99, user_id: 42,
  isMaster: false, isBotMaster: () => false, reply: async () => true }
const allowed = async () => ({ enable: true, privatePreview: false, permissions: {} })
const reset = () => Object.assign(new Error("fixture connection reset"), { code: "ECONNRESET" })
const info = () => Response.json({ errCode: 0, data: {
  sceneInfo: { dynamicExportId: "export/a7890123456789012345" }, errMsg: { type: 0 },
  feedInfo: { description: "合成公开内容", isHardAd: false }, authorInfo: { nickname: "合成作者" },
} })

test("视频号已核短链GET与固定公开查询POST独立重试，不重复已完成短链", async () => {
  let gets = 0, posts = 0
  const bodies: unknown[] = []
  const fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === share) { if (++gets === 1) throw reset(); return Response.redirect(page) }
    expect(String(url)).toBe(api)
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "manual" })
    bodies.push(JSON.parse(String(init?.body)))
    posts++
    return posts < 3 ? new Response("busy", { status: 503 }) : info()
  }, { preconnect() {} })
  const preview = createWeixinChannelsPreview({ fetch, loadConfig: allowed, render: async () => { throw Error("text fixture") } })
  expect(await preview.fallback(share, context)).toContain("合成公开内容")
  expect(gets).toBe(2)
  expect(posts).toBe(3)
  expect(bodies).toEqual(Array.from({ length: 3 }, () => ({ baseReq: { generalToken: "" }, shortUri: id })))
})

test("视频号不重放业务拒绝、错误ID重定向及取消后的查询", async () => {
  let calls = 0
  const business = Object.assign(async (url: string | URL | Request) => {
    calls++
    return String(url) === share ? Response.redirect(page) : Response.json({ errCode: 401 })
  }, { preconnect() {} })
  const unavailable = createWeixinChannelsPreview({ fetch: business, loadConfig: allowed })
  expect(await unavailable.fallback(share, context)).toContain("暂时无法读取")
  expect(calls).toBe(2)
  calls = 0
  const wrong = Object.assign(async () => { calls++; return Response.redirect(page.replace(id, "AAAAAAAAAA")) }, { preconnect() {} })
  await createWeixinChannelsPreview({ fetch: wrong, loadConfig: allowed }).fallback(share, context)
  expect(calls).toBe(1)
  const controller = new AbortController()
  calls = 0
  const cancel = Object.assign(async () => { calls++; controller.abort(); throw reset() }, { preconnect() {} })
  await createWeixinChannelsPreview({ fetch: cancel, loadConfig: allowed, signal: controller.signal }).fallback(share, context)
  expect(calls).toBe(1)
})
