import { expect, test } from "bun:test"
import { BilibiliService } from "../services/bilibili/service.ts"
import { withReadRetries } from "@lotus-yunzai/http"

test("B站短链HEAD内部三次且仍只接受原站落点", async () => {
  let calls = 0
  const service = new BilibiliService({ fetch: async (_url, init) => {
    calls++
    expect(init).toMatchObject({ method: "HEAD", redirect: "manual", credentials: "omit" })
    expect(new Headers(init.headers).has("Cookie")).toBe(false)
    if (calls === 1) return new Response(null, { status: 502 })
    if (calls === 2) throw Object.assign(new Error("reset"), { code: "ECONNRESET" })
    return new Response(null, { status: 302, headers: { Location: "https://www.bilibili.com/video/BV17x411w7KC" } })
  } })
  expect((await service.resolveTarget("https://b23.tv/fixture")).bvid).toBe("BV17x411w7KC")
  expect(calls).toBe(3)
});

test("B站公开直播JSON连接及正文故障共三次，注入wrapper不乘次数", async () => {
  let calls = 0
  const read = withReadRetries(async (url, init) => {
    calls++
    expect(url.origin + url.pathname).toBe("https://api.live.bilibili.com/room/v1/Room/get_info")
    expect(init.credentials).toBe("omit")
    if (calls === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" })
    if (calls === 2) return new Response(new ReadableStream({ start(controller) {
      controller.error(Object.assign(new Error("body reset"), { code: "ECONNRESET" }))
    } }), { headers: { "Content-Type": "application/json" } })
    return Response.json({ code: 0, data: { title: "fixture live", live_status: 1 } })
  })
  const service = new BilibiliService({ fetch: (url, init) => read(new URL(url), init) })
  expect(await service.getLiveInfo("42")).toMatchObject({ title: "fixture live", liveStatus: "直播中" })
  expect(calls).toBe(3)
});

test("B站冷却、未知JSON接口和取消不重试", async () => {
  for (const status of [429, 503]) {
    let calls = 0
    const service = new BilibiliService({ fetch: async () => {
      calls++; return new Response(null, { status, headers: status === 503 ? { "Retry-After": "60" } : {} })
    } })
    await expect(service.getLiveInfo("42")).rejects.toThrow()
    expect(calls).toBe(1)
  }
  let calls = 0
  const unknown = new BilibiliService({ fetch: async () => { calls++; return new Response(null, { status: 502 }) } })
  await expect(unknown.requestJson("https://api.live.bilibili.com/unknown-action")).rejects.toThrow()
  expect(calls).toBe(1)
  const abort = new AbortController(); calls = 0
  const stopped = new BilibiliService({ fetch: async () => {
    calls++; abort.abort(); throw Object.assign(new Error("reset"), { code: "ECONNRESET" })
  } })
  await expect(stopped.getLiveInfo("42", abort.signal)).rejects.toThrow()
  expect(calls).toBe(1)
});
