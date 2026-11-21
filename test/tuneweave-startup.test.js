import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TuneWeaveService, TUNEWEAVE_MANIFEST_URL } from "../services/tuneweave/service.ts"
import { startMediaMaintenance } from "../services/tuneweave/startup.ts"
import { ToolInstallerService } from "../services/tools/installer.ts"

test("TuneWeave 启动恢复只在宿主接管后启动，并随断开取消", async () => {
  let enter
  const inFlight = Promise.withResolvers()
  const disconnect = new AbortController()
  const calls = []
  const runtime = { disconnect:disconnect.signal, whenReady(action) { enter=action; return () => calls.push("取消登记") } }
  const hooks = {
    async load() { calls.push("读配置"); return {} },
    createTune: () => ({ localUrl: () => new URL("http://127.0.0.1"), async resume(signal) {
      calls.push("恢复")
      inFlight.resolve()
      await new Promise(resolve=>signal.addEventListener("abort",resolve,{once:true}))
      calls.push("停止")
    } }),
  }
  expect(startMediaMaintenance({},hooks)).toBeUndefined()
  const maintenance = startMediaMaintenance({mediaRuntime:runtime},hooks)
  expect(calls).toEqual([])
  enter()
  await inFlight.promise
  expect(calls).toEqual(["读配置","恢复"])
  disconnect.abort()
  await maintenance.dispose()
  expect(calls).toEqual(["读配置","恢复","取消登记","停止"])
})

test("自动恢复跳过自建端点和无原记录安装，且不请求错位的本机记录", async () => {
  const dir = await mkdtemp(join(tmpdir(),"lotus-tuneweave-resume-"))
  const local = "http://127.0.0.1:17832"
  const calls = []
  const service = api_url => new TuneWeaveService({root:dir, config:{api_url}, async fetch(url,options) {
    calls.push(new URL(url).pathname)
    expect(options.redirect).toBe("error")
    if (url.endsWith("/healthz")) return Response.json({ok:true,data:{version:"1.0.0-beta.3"}})
    return Response.json({ok:true,data:[{platform:"bilibili",registered:true,
      capabilities:["qr_login","account_profile","search_videos","video_detail","video_parts","video_playback_manifest"]}]})
  }, spawn() { throw new Error("已有监听，无需再起子进程") }})
  try {
    expect(await service(local).resume()).toEqual({skipped:true})
    await mkdir(join(dir,"bin"))
    await writeFile(join(dir,"bin/tuneweave"),"合成文件")
    await writeFile(join(dir,"process.json"),JSON.stringify({pid:2147483647,api_url:local}))
    expect(await service("https://external.example:17832").resume()).toEqual({skipped:true})
    await expect(service("http://127.0.0.1:17833").resume()).rejects.toThrow("进程记录与当前实例不一致")
    expect(calls).toEqual([])
    expect((await service(local).resume()).ok).toBe(true)
    expect(calls).toEqual(["/healthz","/v1/capabilities"])
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test("接管后才维护，FFmpeg 三轮各尝试三次，外部 TuneWeave 全程零请求", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-media-startup-retry-"))
  const started = Promise.withResolvers()
  const calls = []
  const waits = []
  const notices = []
  let activate
  const tool = new ToolInstallerService({ platform: "linux", arch: "x64", async fetch(url) {
    calls.push(String(url).includes("/releases/latest") ? "metadata" : "asset")
    if (calls.at(-1) === "metadata") return Response.json({ assets: [{
      name: "ffmpeg-linux64-gpl.tar.xz", id: 1, browser_download_url: "https://fixture.invalid/ffmpeg",
    }] })
    return new Response(null, { status: 503 })
  } })
  const maintenance = startMediaMaintenance({ mediaRuntime: {
    disconnect: new AbortController().signal,
    whenReady(start) { activate = start; return () => {} },
    async notifyMasters(message) {
      notices.push(message)
      if (notices.length === 3) started.resolve()
    },
  } }, {
    async load() {
      return { tools: { dir, bin_dir: join(dir, "bin") },
        tuneweave: { api_url: "https://external.fixture.invalid/subpath", update_delay_ms: "2300" } }
    },
    createTune: config => new TuneWeaveService({ root: dir, config, async fetch() {
      calls.push("external-tuneweave")
      throw new Error("外部 TuneWeave 禁止参与启动维护")
    } }),
    prepareTools: (config, signal) => tool.ensureAll({ config, signal }),
    async wait(ms) { waits.push(ms) },
  })
  try {
    expect(calls).toEqual([])
    expect(waits).toEqual([])
    activate()
    activate()
    await started.promise
    await maintenance.dispose()
    expect(waits).toEqual([2300, 300000, 300000])
    expect(calls).toEqual(Array.from({ length: 3 }, () => ["metadata", "asset", "asset", "asset"]).flat())
    expect(notices.every(item => item.includes("尚未就绪：ffmpeg"))).toBe(true)
    expect(await readdir(join(dir, "downloads"))).toEqual([])
  } finally {
    await maintenance.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test("TuneWeave 联网校验失败但原服务可用时仍重查，确认同一较新服务后停止", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-media-startup-deferred-"))
  const endpoint = "http://127.0.0.1:17832"
  const finished = Promise.withResolvers()
  const calls = []
  const waits = []
  let rounds = 0
  const service = new TuneWeaveService({ config: { api_url: endpoint }, root: dir, async fetch(url, options) {
    calls.push(url)
    if (url === TUNEWEAVE_MANIFEST_URL) {
      rounds++
      if (rounds === 1) return new Response(null, { status: 503 })
      return Response.json({ version: "1.0.0-beta.3", artifacts: [] })
    }
    expect(options.redirect).toBe("error")
    if (url === endpoint + "/healthz") return Response.json({ ok: true, data: { version: "1.0.0-beta.4" } })
    expect(url).toBe(endpoint + "/v1/capabilities?platform=netease")
    return Response.json({ ok: true, data: [{ platform: "netease", registered: true,
      capabilities: ["platform_api", "qr_login", "account_profile", "caller_managed_credentials"] }] })
  }, spawn() { throw new Error("健康服务无需重启") } })
  const maintenance = startMediaMaintenance({ mediaRuntime: {
    disconnect: new AbortController().signal,
    whenReady(action) { action(); return () => {} },
    async notifyMasters(message) {
      expect(message).toContain("更新完成：ffmpeg")
      finished.resolve()
    },
  } }, {
    async load() { return {} },
    createTune: () => service,
    async prepareTools() {
      return { ok: true, items: [{ name: "ffmpeg", ok: true, status: rounds ? "installed" : "ready" }] }
    },
    async wait(ms) { waits.push(ms) },
  })
  try {
    await finished.promise
    await maintenance.dispose()
    expect(waits).toEqual([180000, 300000])
    expect(rounds).toBe(2)
    expect(calls.filter(url => url.endsWith("/healthz"))).toHaveLength(3)
    expect(await readdir(dir)).toEqual([])
  } finally {
    await maintenance.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test("开机维护可取消 FFmpeg 部分传输与 TuneWeave 下载，在取消后不重试或发布二进制", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-media-startup-cancel-"))
  const ffAbort = new AbortController()
  const tuneAbort = new AbortController()
  const ffReading = Promise.withResolvers()
  const tuneReading = Promise.withResolvers()
  let ffDownloads = 0
  let tuneDownloads = 0
  const installer = new ToolInstallerService({ platform: "linux", arch: "x64", async fetch(url) {
    if (String(url).includes("/releases/latest")) return Response.json({ assets: [{
      name: "ffmpeg-linux64-gpl.tar.xz", browser_download_url: "https://fixture.invalid/asset", digest: "sha256:" + "a".repeat(64),
    }] })
    ffDownloads++
    return new Response(new ReadableStream({
      pull(controller) {
        ffReading.resolve()
        controller.enqueue(Uint8Array.of(1, 2, 3))
        return new Promise(resolve => ffAbort.signal.addEventListener("abort", resolve, { once: true }))
      },
    }))
  } })
  const releaseRoot = "https://github.com/MOPELotus/TuneWeave/releases/download/v1.0.0-beta.3/"
  const artifact = releaseRoot + "fixture"
  const tune = new TuneWeaveService({ root: join(dir, "tune"), platform: "linux", arch: "x64", async fetch(url, options) {
    if (url === artifact + ".sha256") return new Response("a".repeat(64))
    expect(url).toBe(artifact)
    tuneDownloads++
    tuneReading.resolve()
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }))
  } })
  try {
    const ffWork = installer.ensureAll({ config: { dir: join(dir, "ff"), bin_dir: join(dir, "ff/bin") }, signal: ffAbort.signal })
    const tuneWork = tune.downloadRelease({ version: "1.0.0-beta.3", artifacts: [{
      platform: "linux", architecture: "x86_64", download_url: artifact,
      verification: { algorithm: "sha256", checksum_url: artifact + ".sha256" },
    }] }, tuneAbort.signal)
    await Promise.race([Promise.all([ffReading.promise, tuneReading.promise]), Promise.all([ffWork, tuneWork])])
    ffAbort.abort()
    tuneAbort.abort()
    await expect(ffWork).rejects.toMatchObject({ name: "AbortError" })
    await expect(tuneWork).rejects.toMatchObject({ name: "AbortError" })
    expect(ffDownloads).toBe(1)
    expect(tuneDownloads).toBe(1)
    expect(await readdir(join(dir, "ff/downloads"))).toEqual([])
    expect(await readdir(join(dir, "tune/bin"))).toEqual([])
  } finally {
    ffAbort.abort()
    tuneAbort.abort()
    await rm(dir, { recursive: true, force: true })
  }
})
