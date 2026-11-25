import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadMedia } from "../services/media/download.ts"
import { downloadRanges } from "../services/media/range-download.ts"
import { TuneWeaveService } from "../services/tuneweave/service.ts"
import { withReadRetries } from "@lotus-yunzai/http"

const mp4 = Buffer.from("00000010667479706d70343200000000", "hex")
const reset = () => Object.assign(new Error("reset"), { code: "ECONNRESET" })
function broken() { return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(mp4.subarray(0, 4)) }, pull(c) { c.error(reset()) } }) }

test("整流断连清理旧part后同址三次，嵌套HTTP预算不相乘", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-stream-retry-"))
  let calls = 0
  try {
    const base = withReadRetries(async () => {
      calls++
      if (calls === 1) throw reset()
      if (calls === 2) return new Response(broken())
      expect(await readdir(root)).toEqual([])
      return new Response(mp4)
    })
    const result = await downloadMedia("https://v3.douyinvod.com/a", join(root, "out"), { fetch: (url, init) => base(new URL(url), init ?? {}), kind: "video" })
    expect(calls).toBe(3)
    expect(await readFile(result.file)).toEqual(mp4)
    expect(await readdir(root)).toEqual(["out.mp4"])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("range探测及短轨正文分别有限重试，不把整流失败当成功发布", async () => {
  for (const direct of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "lotus-range-retry-"))
    let probes = 0, full = 0
    try {
      const target = join(root, "out")
      const result = await downloadRanges("https://fixture.invalid/a", target, { fetch: async (_url, init) => {
        if (new Headers(init?.headers).has("range")) {
          probes++
          if (probes < 3) return new Response(null, { status: 502 })
          if (direct) { full++; return new Response(broken()) }
          return new Response(mp4.subarray(0, 1), { status: 206, headers: { "Content-Range": "bytes 0-0/16" } })
        }
        full++
        if (full < 3) return new Response(broken())
        expect(await readdir(root)).toEqual([])
        return new Response(mp4, { headers: { "Content-Length": "16" } })
      } })
      expect(probes).toBe(3); expect(full).toBe(3)
      expect(result.sizeBytes).toBe(16); expect(await readFile(target)).toEqual(mp4)
      expect(await readdir(root)).toEqual(["out"])
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

test("整流限流、Retry-After、格式与大小拒绝均不重试", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-stream-terminal-"))
  try {
    for (const response of [new Response(null, { status: 429 }), new Response(null, { status: 503, headers: { "Retry-After": "30" } }), new Response(broken(), { headers: { "Retry-After": "30" } }), new Response("html"), new Response(mp4, { headers: { "Content-Length": "16" } })]) {
      let calls = 0
      await expect(downloadMedia("https://v3.douyinvod.com/a", join(root, "out"), { maxBytes: 8, fetch: async () => { calls++; return response } })).rejects.toThrow()
      expect(calls).toBe(1); expect(await readdir(root)).toEqual([])
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("TuneWeave只对白名单公开GET重试，不重放QR或POST", async () => {
  for (const [route, method, expected] of [["/healthz", "GET", 3], ["/v1/capabilities?platform=qq", "GET", 3], ["/v1/search?q=a", "GET", 3], ["/v1/qr", "GET", 1], ["/v1/search", "POST", 1]] as const) {
    let calls = 0
    const service = new TuneWeaveService({ fetch: async () => { calls++; throw reset() } })
    await expect(service.request(route, { method })).rejects.toThrow("无法连接")
    expect(calls).toBe(expected)
  }
})

test("正常EOF但短正文也从零重试，分段429和RetryAfter不重放", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-stream-short-"))
  try {
    let calls = 0
    const result = await downloadMedia("https://v3.douyinvod.com/a", join(root, "short"), { fetch: async () => {
      calls++
      return new Response(calls < 3 ? mp4.subarray(0, 8) : mp4, { headers: { "Content-Length": "16" } })
    } })
    expect(calls).toBe(3); expect(await readFile(result.file)).toEqual(mp4)
    for (const status of [429, 503]) {
      const requests = new Map<string, number>()
      await expect(downloadRanges("https://fixture.invalid/a", join(root, "chunks"), { concurrency: 2, fetch: async (_url, init) => {
        const range = new Headers(init?.headers).get("Range")!
        requests.set(range, (requests.get(range) ?? 0) + 1)
        if (range === "bytes=0-0") return new Response("x", { status: 206, headers: { "Content-Range": "bytes 0-0/2097160" } })
        return new Response(null, { status, headers: status === 503 ? { "Retry-After": "30" } : {} })
      } })).rejects.toThrow()
      expect([...requests.values()].every(count => count === 1)).toBe(true)
    }
    expect(await readdir(root)).toEqual(["short.mp4"])
  } finally { await rm(root, { recursive: true, force: true }) }
})
