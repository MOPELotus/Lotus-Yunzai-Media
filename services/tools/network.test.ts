import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolInstallerService } from "./installer.ts"
import { TuneWeaveService, TUNEWEAVE_MANIFEST_URL } from "../tuneweave/service.ts"
import type { TaskProgress } from "../progress.ts"

const reset = () => Object.assign(new Error("socket reset"), { code: "ECONNRESET" })

test("FFmpeg 元数据临时断连有界重试，只有结构化观察者也报告主机和尝试阶段", async () => {
  let calls = 0
  const events: TaskProgress[] = []
  const service = new ToolInstallerService({ fetch: (async () => {
    calls++
    if (calls === 1) throw reset()
    if (calls === 2) return new Response(null, { status: 503 })
    return Response.json({ assets: [] })
  }) as unknown as typeof fetch })
  expect(await service.fetchLatestRelease("fixture/ffmpeg", undefined, null, undefined, event => events.push(event))).toEqual({ assets: [] })
  expect(calls).toBe(3)
  expect(events.filter(event => event.stage === "release-retry")).toHaveLength(2)
  expect(events.at(-1)?.message).toContain("api.github.com，尝试 3/3")
  calls = 0
  const unavailable = new ToolInstallerService({ fetch: (async () => { calls++; throw reset() }) as unknown as typeof fetch })
  await expect(unavailable.fetchLatestRelease("fixture/ffmpeg")).rejects.toThrow("查询 FFmpeg 发布版本 fixture/ffmpeg失败（api.github.com，已尝试 3 次）：ECONNRESET")
  expect(calls).toBe(3)
})

test("发布元数据认证/永久错误和无效 JSON 不重试，原始错误保留在诊断中", async () => {
  for (const status of [401, 403, 404, 501]) {
    let calls = 0
    const service = new ToolInstallerService({ fetch: (async () => { calls++; return new Response(null, { status }) }) as unknown as typeof fetch })
    await expect(service.fetchLatestRelease("fixture/ffmpeg")).rejects.toThrow(`HTTP ${status}`)
    expect(calls).toBe(1)
  }
  let calls = 0
  const malformed = new ToolInstallerService({ fetch: (async () => { calls++; return new Response("invalid-json") }) as unknown as typeof fetch })
  await expect(malformed.fetchLatestRelease("fixture/ffmpeg")).rejects.toThrow("已尝试 1 次")
  expect(calls).toBe(1)
  calls = 0
  const certificateFailure = new ToolInstallerService({ fetch: (async () => {
    calls++
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" }) })
  }) as unknown as typeof fetch })
  await expect(certificateFailure.fetchLatestRelease("fixture/ffmpeg")).rejects.toThrow("CERT_HAS_EXPIRED")
  expect(calls).toBe(1)
})

test("FFmpeg 发布文件认证错误立即停止，不消耗其余安装重试", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-media-network-"))
  let downloads = 0
  const events: TaskProgress[] = []
  const service = new ToolInstallerService({ platform: "linux", arch: "x64", fetch: (async (url: string | URL | Request) => {
    if (String(url).includes("/releases/latest")) return Response.json({ assets: [{ name: "ffmpeg-linux64-gpl.tar.xz", browser_download_url: "https://assets.fixture.invalid/ffmpeg", digest: "sha256:" + "a".repeat(64) }] })
    downloads++
    return new Response(null, { status: 401 })
  }) as unknown as typeof fetch })
  try {
    const result = await service.ensureAll({ config: { dir: directory, bin_dir: join(directory, "bin") }, onTaskProgress: event => events.push(event) })
    expect(result.ok).toBe(false)
    expect(result.items[0]).toMatchObject({ ok: false, reason: "FFmpeg 发布文件下载失败（assets.fixture.invalid）：HTTP 401" })
    expect(downloads).toBe(1)
    expect(events.some(event => event.message.includes("查询 FFmpeg 发布版本"))).toBe(true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("元数据重试等待可取消，取消后不继续请求", async () => {
  let calls = 0
  const controller = new AbortController()
  const service = new ToolInstallerService({ fetch: (async () => { calls++; throw reset() }) as unknown as typeof fetch })
  await expect(service.fetchLatestRelease("fixture/ffmpeg", undefined, null, controller.signal, event => {
    if (event.stage === "release-retry") controller.abort()
  })).rejects.toMatchObject({ name: "AbortError" })
  expect(calls).toBe(1)
})

test("TuneWeave 官方发布认证失败不切到 curl 或重试", async () => {
  let calls = 0
  const service = new TuneWeaveService({ fetch: (async () => { calls++; return new Response(null, { status: 403 }) }) as unknown as typeof fetch })
  await expect(service.publicDownload(TUNEWEAVE_MANIFEST_URL)).rejects.toThrow("HTTP 403")
  expect(calls).toBe(1)
})

test("FFmpeg 发布文件临时服务错误有界重试并保留阶段、主机与 HTTP 状态", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-media-download-retry-"))
  let downloads = 0
  const events: TaskProgress[] = []
  const service = new ToolInstallerService({ platform: "linux", arch: "x64", fetch: (async (url: string | URL | Request) => {
    if (String(url).includes("/releases/latest")) return Response.json({ assets: [{ name: "ffmpeg-linux64-gpl.tar.xz", browser_download_url: "https://assets.fixture.invalid/ffmpeg", digest: "sha256:" + "a".repeat(64) }] })
    downloads++
    return new Response(null, { status: 503 })
  }) as unknown as typeof fetch })
  try {
    const result = await service.ensureAll({ config: { dir: directory, bin_dir: join(directory, "bin") }, onTaskProgress: event => events.push(event) })
    expect(result.ok).toBe(false)
    expect(result.items[0]).toMatchObject({ ok: false, reason: "FFmpeg 发布文件下载或安装失败（assets.fixture.invalid，已尝试 3 次）：HTTP 503" })
    expect(downloads).toBe(3)
    expect(events.filter(event => event.message.includes("已清理并准备重试"))).toHaveLength(2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("TuneWeave body 中途断连重试整个下载包，三次封顶且失败残片清理", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-tuneweave-body-retry-"))
  const bytes = new TextEncoder().encode("fixture executable")
  const checksum = createHash("sha256").update(bytes).digest("hex")
  const url = "https://github.com/MOPELotus/TuneWeave/releases/download/v1.0.0-beta.3/tuneweave"
  const manifest = { version: "1.0.0-beta.3", artifacts: [{ platform: "linux", architecture: "x86_64", download_url: url,
    verification: { algorithm: "sha256", checksum_url: url + ".sha256" } }] }
  let downloads = 0, alwaysFail = false
  const service = new TuneWeaveService({ root: directory, platform: "linux", arch: "x64", fetch: (async (target: string | URL | Request) => {
    if (String(target).endsWith(".sha256")) return new Response(checksum)
    downloads++
    if (!alwaysFail && downloads > 1) return new Response(bytes, { headers: { "content-length": String(bytes.length) } })
    let reading = false
    return new Response(new ReadableStream({ pull(controller) {
      if (!reading) { reading = true; controller.enqueue(bytes.slice(0, 2)) }
      else controller.error(reset())
    } }), { headers: { "content-length": String(bytes.length) } })
  }) as unknown as typeof fetch })
  const events: TaskProgress[] = []
  try {
    const release = await service.downloadRelease(manifest, undefined, event => events.push(event))
    expect(downloads).toBe(2)
    expect(await readFile(release.file)).toEqual(Buffer.from(bytes))
    expect(events.some(event => event.stage === "release-retry" && event.message.includes("ECONNRESET"))).toBe(true)
    await rm(release.file)
    alwaysFail = true
    downloads = 0
    await expect(service.downloadRelease(manifest)).rejects.toThrow("已尝试 3 次")
    expect(downloads).toBe(3)
    expect(await readdir(join(directory, "bin"))).toEqual([])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
