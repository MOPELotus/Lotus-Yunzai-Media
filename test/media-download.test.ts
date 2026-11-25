import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadMedia } from "../services/media/download.ts"

const cdn = "https://v3.douyinvod.com/asset"
const mp4 = Buffer.from("00000010667479706d70343200000000", "hex")

test("全量下载拒绝带合法媒体头的部分响应、假长度、超限和错误类型", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-whole-media-"))
  const target = join(root, "source")
  const file = target + ".mp4"
  try {
    await writeFile(file, "previous")
    for (const [body, status, headers, message, maxBytes] of [
      [mp4, 206, { "Content-Range": "bytes 0-15/100" }, "HTTP 206", 100],
      [mp4, 200, { "Content-Range": "bytes 0-15/100" }, "HTTP 200", 100],
      [mp4, 200, { "Content-Length": "0" }, "不完整", 100],
      [mp4, 200, { "Content-Length": "1.6e1" }, "不完整", 100],
      [mp4, 200, { "Content-Length": "17" }, "不完整", 100],
      [mp4, 200, { "Content-Length": "15" }, "不完整", 100],
      [mp4, 200, { "Content-Length": "16" }, "超过下载限制", 15],
      ["<html>没有源文件</html>", 200, {}, "不是预期媒体", 1024],
    ] as const) {
      const response = new Response(body, { status, headers })
      await expect(downloadMedia(cdn, target, { fetch: async () => response.clone(), kind: "video", maxBytes })).rejects.toThrow(message)
      expect(await readFile(file, "utf8")).toBe("previous")
      expect(await readdir(root)).toEqual(["source.mp4"])
    }
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(mp4.subarray(0, 6))
        controller.enqueue(mp4.subarray(6))
        controller.close()
      },
    }))
    expect(response.headers.has("content-length")).toBe(false)
    await expect(downloadMedia(cdn, target, { kind: "video", maxBytes: 16, fetch: async () => response }))
      .resolves.toEqual({ file, kind: "video", sizeBytes: 16 })
    expect(await readFile(file)).toEqual(mp4)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("全量响应阻塞时取消读流并清临时文件，不等下一块才报告流式超限", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-whole-cancel-"))
  const target = join(root, "source")
  try {
    let cancelled = 0
    const stream = () => new ReadableStream({
      start(controller) { controller.enqueue(mp4) },
      pull() { return new Promise<never>(() => {}) },
      cancel() { cancelled++ },
    })
    await expect(downloadMedia(cdn, target, { timeoutMs: 100, fetch: async () => new Response(stream()) })).rejects.toThrow("下载超时")
    await expect(downloadMedia(cdn, target, { timeoutMs: 100, fetch: async () => new Response(stream()), maxBytes: 8 }))
      .rejects.toThrow("超过下载限制")
    const begin = Promise.withResolvers<void>(), abort = new AbortController()
    const pending = downloadMedia(cdn, target, { timeoutMs: 5000, signal: abort.signal, fetch: async () => new Response(
      new ReadableStream({ pull() { begin.resolve(); return new Promise<never>(() => {}) }, cancel() { cancelled++ } })) })
    await begin.promise
    abort.abort()
    await expect(pending).rejects.toThrow("下载已取消")
    expect(cancelled).toBe(3)
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
