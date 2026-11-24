import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolInstallerService } from "./tools/installer.ts"
import { TuneWeaveService } from "./tuneweave/service.ts"
import { emitTaskProgress, responseBytes, type TaskProgress } from "./progress.ts"

function response(bytes: Uint8Array, total: boolean) {
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 2))
    controller.enqueue(bytes.slice(2))
    controller.close()
  } }), { headers: total ? { "content-length": String(bytes.length) } : {} })
}

test("FFmpeg 流式下载报告真实字节，未知长度不编造总量，观察者失败不破坏文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-ffmpeg-progress-"))
  const bytes = new TextEncoder().encode("fixture archive")
  try {
    for (const known of [true, false]) {
      const events: TaskProgress[] = []
      const installer = new ToolInstallerService({ fetch: (() => Promise.resolve(response(bytes, known))) as unknown as typeof fetch })
      const file = join(root, String(known))
      await installer.downloadAsset("https://fixture.invalid", file, { onTaskProgress(event) {
        events.push(event)
        if (event.completed === 0) throw new Error("broken observer")
        return Promise.reject(new Error("rejected observer"))
      } })
      expect(await readFile(file)).toEqual(Buffer.from(bytes))
      const transfers = events.filter(event => event.stage === "ffmpeg-download")
      expect(transfers[0]?.completed).toBe(0)
      expect(events.at(-1)).toMatchObject({ stage: "ffmpeg-download", completed: bytes.length, unit: "bytes" })
      expect(transfers.every(event => event.total === (known ? bytes.length : undefined))).toBe(true)
    }
    expect(responseBytes(new Response("fixture", { headers: { "content-length": "3", "content-encoding": "gzip" } }))).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("TuneWeave 下载进度与 SHA-256 核对有序，错误校验不得留下发布文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-tuneweave-progress-"))
  const bytes = new TextEncoder().encode("fixture executable")
  const url = "https://github.com/MOPELotus/TuneWeave/releases/download/v1.0.0-beta.3/tuneweave"
  const manifest = { version: "1.0.0-beta.3", artifacts: [{ platform: "linux", architecture: "x86_64", download_url: url,
    verification: { algorithm: "sha256", checksum_url: url + ".sha256" } }] }
  let checksum = createHash("sha256").update(bytes).digest("hex")
  const service = new TuneWeaveService({ root, platform: "linux", arch: "x64", fetch: (async (url: string | URL | Request) =>
    String(url).endsWith(".sha256") ? new Response(checksum) : response(bytes, true)) as unknown as typeof fetch })
  try {
    const events: TaskProgress[] = []
    const release = await service.downloadRelease(manifest, undefined, event => events.push(event))
    expect(await readFile(release.file)).toEqual(Buffer.from(bytes))
    const downloads = events.filter(event => event.stage === "tuneweave-download")
    expect(downloads.at(-1)).toMatchObject({ completed: bytes.length, total: bytes.length, unit: "bytes" })
    expect(events.at(-1)?.stage).toBe("tuneweave-verify")
    await rm(release.file)
    checksum = "0".repeat(64)
    await expect(service.downloadRelease(manifest, undefined, () => { throw new Error("observer") })).rejects.toThrow("SHA-256")
    expect(await readdir(join(root, "bin"))).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("异步与同步进度观察者错误均被隔离", async () => {
  const event = { stage: "check", message: "checking" }
  expect(() => emitTaskProgress(() => { throw new Error("sync") }, event)).not.toThrow()
  emitTaskProgress(() => Promise.reject(new Error("async")), event)
  await Promise.resolve()
})
