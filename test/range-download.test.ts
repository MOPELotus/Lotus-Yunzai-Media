import { expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadRanges } from "../services/media/range-download.ts"

test("短轨道的完整请求必须与探测总长度一致，过短和部分响应只能切镜", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-range-full-"))
  const file = join(root, "track.m4s")
  const actual = "完整轨道".repeat(3)
  const total = Buffer.byteLength(actual)
  const requests: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname
    const range = request.headers.get("range")
    requests.push(`${path} ${range ?? "全量"}`)
    if (range === "bytes=0-0") return new Response("a", { status: 206, headers: { "Content-Range": `bytes 0-0/${total}` } })
    if (path === "/short") return new Response("short")
    if (path === "/partial") return new Response("x", { status: 206, headers: { "Content-Range": `bytes 0-0/${total}` } })
    return new Response(actual)
  } })
  try {
    const urls = ["invalid", "data:,ignored", ...["short", "partial", "valid"].map(path => new URL(path, server.url).href)]
    await expect(downloadRanges(urls, file,
      { maxBytes: total })).resolves.toEqual({ file, sizeBytes: total })
    expect(await readFile(file, "utf8")).toBe(actual)
    expect(requests).toEqual(["/short bytes=0-0", "/short 全量", "/partial bytes=0-0", "/partial 全量", "/valid bytes=0-0", "/valid 全量"])
    expect(await readdir(root)).toEqual(["track.m4s"])
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test("分片同镜重试三次，换镜重新写全体并在成功后才发布", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-range-retry-"))
  const target = join(root, "track.m4s")
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 8, 0x78)
  const half = bytes.length / 2
  bytes.fill(0x79, half)
  const attempts = new Map<string, number>()
  try {
    const result = await downloadRanges(["https://primary.example/play", "https://mirror.example/play"], target, {
      maxBytes: bytes.length, concurrency: 2,
      fetch: async (url, options) => {
        const range = new Headers(options?.headers).get("range")
        const host = new URL(String(url)).hostname
        const key = `${host} ${range}`
        attempts.set(key, (attempts.get(key) ?? 0) + 1)
        if (range === "bytes=0-0") return new Response("x", { status: 206,
          headers: { "Content-Range": `bytes 0-0/${bytes.length}`, ETag: '"track"' } })
        expect(new Headers(options?.headers).get("if-range")).toBe('"track"')
        const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(range!)!
        const from = Number(first), until = Number(last) + 1
        const expected = `${from}-${until - 1}/${bytes.length}`
        if (host === "primary.example" && from === 0) {
          const broken = attempts.get(key) === 1 ? Buffer.alloc(until - 1) : Buffer.alloc(until + 1)
          return new Response(broken, { status: 206, headers: { "Content-Range": `bytes ${expected}` } })
        }
        const body = host === "primary.example" ? Buffer.alloc(until - from, 0x55) : bytes.subarray(from, until)
        return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${expected}` } })
      },
    })
    expect(result).toEqual({ file: target, sizeBytes: bytes.length })
    expect(attempts.get(`primary.example bytes=0-${half - 1}`)).toBe(3)
    expect(attempts.get(`mirror.example bytes=0-${half - 1}`)).toBe(1)
    expect(attempts.get(`mirror.example bytes=${half}-${bytes.length - 1}`)).toBe(1)
    expect((await readFile(target)).equals(bytes)).toBe(true)
    expect(await readdir(root)).toEqual(["track.m4s"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("无长度的响应超限或取消时保留上次文件并清除临时结果", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-range-abort-"))
  const file = join(root, "track.m4s")
  const abort = new AbortController()
  try {
    await writeFile(file, "previous")
    await expect(downloadRanges("https://only.example/oversize", file, {
      maxBytes: 4, fetch: async () => new Response("large"),
    })).rejects.toThrow("大小限制")
    const response = new Response(new ReadableStream({ pull(controller) {
      abort.abort()
      controller.enqueue(Uint8Array.of(65))
      controller.close()
    } }))
    await expect(downloadRanges("https://only.example/abort", file, {
      signal: abort.signal, fetch: async () => response,
    })).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe("previous")
    expect(await readdir(root)).toEqual(["track.m4s"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
