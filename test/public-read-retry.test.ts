import { expect, test } from "bun:test"
import { readPublicResponse } from "../services/public-read.ts"
import { readPublicSharePage } from "../services/public-share/page.ts"
import { fetchImageBytes } from "../core/render/image.ts"
import { createBiliComments } from "../services/bilibili/comments.ts"
import { fetchPublicWeiboComments, fetchPublicWeiboPost } from "../services/subscriptions/weibo/index.ts"

const reset = () => Object.assign(new Error("fixture connection reset"), { code: "ECONNRESET" })

test("公开页面连接中断与503在同一信号内最多尝试三次，仍校验重定向目标", async () => {
  let calls = 0
  const signal = new AbortController().signal
  const result = await readPublicSharePage(new URL("https://public.example/post/1"), url => url.origin === "https://public.example", async (_url, options) => {
    expect(options).toMatchObject({ credentials: "omit", redirect: "manual", signal })
    calls++
    if (calls === 1) throw reset()
    if (calls === 2) return new Response("busy", { status: 503 })
    return new Response("<html>fixture</html>")
  }, signal)
  expect(result?.html).toBe("<html>fixture</html>")
  expect(calls).toBe(3)
  calls = 0
  await readPublicSharePage(new URL("https://public.example/post/1"), url => url.origin === "https://public.example", async () => {
    calls++
    return Response.redirect("https://untrusted.example/item")
  }, signal)
  expect(calls).toBe(1)
})

test("嵌套图片读取不叠乘三次预算，原图字节与大小限制保留", async () => {
  let calls = 0
  const bytes = Buffer.from("fixture image bytes")
  const transport = async () => {
    calls++
    if (calls < 3) throw reset()
    return new Response(bytes)
  }
  const image = await fetchImageBytes("https://i0.hdslb.com/fixture.png", {
    fetch: (url, init) => readPublicResponse(transport, url, init), maxBytes: 64,
  })
  expect(image).toEqual(bytes)
  expect(calls).toBe(3)
  calls = 0
  await expect(fetchImageBytes("https://i0.hdslb.com/fixture.png", {
    fetch: async () => { calls++; return new Response(bytes) }, maxBytes: 2,
  })).rejects.toThrow()
  expect(calls).toBe(1)
})

test("公开评论503恢复后读取原目标，不重试业务拒绝与429", async () => {
  let calls = 0
  const comments = createBiliComments(async () => {
    calls++
    return calls === 1 ? new Response("busy", { status: 503 }) : Response.json({ code: 0, data: { replies: [] } })
  })
  expect(await comments.firstPage({ oid: "123", type: 1 })).toEqual([])
  expect(calls).toBe(2)
  calls = 0
  expect(await createBiliComments(async () => { calls++; return Response.json({ code: 12002 }) }).firstPage({ oid: "123", type: 1 })).toEqual([])
  expect(calls).toBe(1)
  calls = 0
  await expect(createBiliComments(async () => { calls++; return new Response("limited", { status: 429 }) }).firstPage({ oid: "123", type: 1 })).rejects.toThrow()
  expect(calls).toBe(1)
})

test("微博公开评论恢复可读取，页面和API回退共用最多三次请求", async () => {
  let calls = 0
  expect(await fetchPublicWeiboComments("123", undefined, async () => {
    calls++
    return calls === 1 ? new Response("busy", { status: 503 }) : Response.json({ ok: 1, data: { data: [] } })
  })).toEqual([])
  expect(calls).toBe(2)
  calls = 0
  await fetchPublicWeiboPost({ id: "123" }, undefined, async () => { calls++; throw reset() })
  expect(calls).toBe(3)
})

test("写请求和业务限流不重放，取消后不会进入下一次读取", async () => {
  for (const status of [429, 401, 403]) {
    let calls = 0
    expect((await readPublicResponse(async () => { calls++; return new Response("no", { status }) }, "https://public.example/post")).status).toBe(status)
    expect(calls).toBe(1)
  }
  let calls = 0
  expect((await readPublicResponse(async () => { calls++; return new Response("error", { status: 503 }) }, "https://public.example/write", { method: "POST", body: "fixture" })).status).toBe(503)
  expect(calls).toBe(1)
  const controller = new AbortController()
  calls = 0
  await expect(readPublicResponse(async () => { calls++; controller.abort(); throw reset() }, "https://public.example/read", { signal: controller.signal })).rejects.toThrow()
  expect(calls).toBe(1)
})
