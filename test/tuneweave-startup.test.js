import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selectTuneWeaveArtifact, TuneWeaveService, TUNEWEAVE_MANIFEST_URL } from "../services/tuneweave/service.ts"
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

test("接管后只检查已有FFmpeg，缺失时提示初始化且不请求任何发布或下载地址", async () => {
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
      return { tools: { dir, bin_dir: join(dir, "bin"), ffmpeg: { command: "lotus-fixture-absent-ffmpeg" } },
        tuneweave: { api_url: "https://external.fixture.invalid/subpath", update_delay_ms: "2300" } }
    },
    createTune: config => new TuneWeaveService({ root: dir, config, async fetch() {
      calls.push("external-tuneweave")
      throw new Error("外部 TuneWeave 禁止参与启动维护")
    } }),
    prepareTools: (config, signal) => tool.checkAll({ config, signal }),
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
    expect(calls).toEqual([])
    expect(notices.every(item => item.includes("检查失败：ffmpeg"))).toBe(true)
    expect(await readdir(dir)).toEqual([])
  } finally {
    await maintenance.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test("已有TuneWeave启动只读本地健康能力接口，不查询发布或下载安装", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-media-startup-readonly-"))
  const endpoint = "http://127.0.0.1:17832", calls = [], waits = []
  const service = new TuneWeaveService({ config: { api_url: endpoint }, root: dir, async fetch(url, options) {
    calls.push(url)
    if (!url.startsWith(endpoint)) throw new Error("启动不应请求发布或下载")
    expect(options.redirect).toBe("error")
    if (url.endsWith("/healthz")) return Response.json({ ok: true, data: { version: "1.0.0-beta.4" } })
    return Response.json({ ok: true, data: [{ platform: "netease", registered: true,
      capabilities: ["platform_api", "qr_login", "account_profile", "caller_managed_credentials"] }] })
  }, spawn() { throw new Error("健康服务无需重启") } })
  const maintenance = startMediaMaintenance({ mediaRuntime: {
    disconnect: new AbortController().signal, whenReady(action) { action(); return () => {} },
    async notifyMasters() { throw new Error("健康检查无需通知更新") },
  } }, {
    async load() { return {} }, createTune: () => service,
    async prepareTools() { return { ok: true, items: [{ name: "ffmpeg", ok: true, status: "ready" }] } },
    async wait(ms) { waits.push(ms) },
  })
  try {
    expect(await maintenance.waitForFirstRound(new AbortController().signal)).toBe("ready")
    expect(waits).toEqual([0])
    expect(calls).toHaveLength(2)
    expect(calls.every(url => url.startsWith(endpoint))).toBe(true)
  } finally { await maintenance.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test("TuneWeave 更新按兼容契约选择，只有已验历史版本可以缺省", async () => {
  const legacy = { version: "1.0.0-beta.3", artifacts: [] }
  const current = { version: "1.0.0-beta.4", api_version: "v1", artifacts: [] }
  let manifest = legacy
  const service = new TuneWeaveService({ async fetch(url) {
    expect(url).toBe(TUNEWEAVE_MANIFEST_URL)
    return Response.json(manifest)
  } })
  expect(await service.releaseManifest()).toEqual(legacy)
  manifest = { ...current, compatibility_profiles: ["future-client", "tuneweave-http-v1"] }
  expect(await service.releaseManifest()).toEqual(manifest)
  manifest = { ...current, api_version: "v2", compatibility_profiles: ["tuneweave-http-v1", "future-client"] }
  expect(await service.releaseManifest()).toEqual(manifest)

  for (const [value, error] of [
    [current, "未声明"],
    [{ ...current, compatibility_profiles: ["future-client"] }, "不兼容"],
    [{ ...legacy, api_version: "v1", compatibility_profiles: ["tuneweave-http-v1", "tuneweave-http-v1"] }, "声明无效"],
    [{ ...current, compatibility_profiles: null }, "声明无效"],
    [{ ...current, compatibility_profiles: ["tuneweave-http-v1", "不可用"] }, "声明无效"],
    [{ ...legacy, api_version: "v2" }, "未声明"],
  ]) {
    manifest = value
    await expect(service.releaseManifest()).rejects.toThrow(error)
  }

  const official = "https://github.com/MOPELotus/TuneWeave/releases/download/"
  expect(() => selectTuneWeaveArtifact({ ...current, artifacts: [{
    platform: "linux", architecture: "x86_64", download_url: official + "v1.0.0-beta.4/tuneweave",
    verification: { algorithm: "sha256", checksum_url: official + "v1.0.0-beta.3/tuneweave.sha256" },
  }] }, "linux", "x64")).toThrow("版本与下载地址不一致")
})

test("未声明兼容性的发布件不替换健康的 TuneWeave 本机服务", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-tuneweave-incompatible-"))
  const endpoint = "http://127.0.0.1:17833"
  const calls = []
  try {
    const service = new TuneWeaveService({
      root: directory,
      config: { api_url: endpoint },
      spawn() { throw new Error("现有进程不得重启") },
      async fetch(url) {
        calls.push(url)
        if (url === TUNEWEAVE_MANIFEST_URL) return Response.json({ version: "1.0.0-beta.4", api_version: "v1", artifacts: [] })
        if (url === endpoint + "/healthz") return Response.json({ ok: true, data: { version: "1.0.0-beta.3" } })
        expect(url).toBe(endpoint + "/v1/capabilities?platform=netease")
        return Response.json({ ok: true, data: [{ platform: "netease", registered: true,
          capabilities: ["platform_api", "qr_login", "account_profile", "caller_managed_credentials"] }] })
      },
    })
    const result = await service.initialize({ platform: "netease" })
    expect(result).toMatchObject({ version: "1.0.0-beta.3", reachable: true, already: true, updateDeferred: true })
    expect(result.message).toContain("未声明客户端兼容性")
    expect(calls).toEqual([endpoint + "/healthz", endpoint + "/v1/capabilities?platform=netease", TUNEWEAVE_MANIFEST_URL,
      endpoint + "/healthz", endpoint + "/v1/capabilities?platform=netease"])
  } finally {
    await rm(directory, { recursive: true, force: true })
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

test("状态未知的本机 HTTP 服务和失效探测不会触发安装或改写旧程序", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-tuneweave-unknown-"))
  const releaseCalls = []
  let state = "capabilities"
  const listening = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname
    if (state === "invalid-http") return new Response("other local service")
    if (path === "/healthz") return Response.json({ ok: true, data: {
      version: state === "version" ? "无法识别的返回内容" : "1.0.0-beta.4",
    } })
    return new Response(null, { status: 503 })
  } })
  const endpoint = listening.url.origin
  const service = new TuneWeaveService({
    root: directory,
    config: { api_url: endpoint },
    spawn() { throw new Error("未知状态不可启动子进程") },
    async fetch(url, init) {
      if (url.startsWith(endpoint)) {
        if (state === "timeout") throw new DOMException("timeout", "TimeoutError")
        return fetch(url, init)
      }
      releaseCalls.push(url)
      return new Response(null, { status: 503 })
    },
  })
  try {
    await mkdir(join(directory, "bin"))
    const installed = join(directory, "bin/tuneweave")
    await writeFile(installed, "原程序")
    const record = join(directory, "process.json"), saved = JSON.stringify({ pid: 2147483647, api_url: endpoint })
    await writeFile(record, saved)
    for (state of ["capabilities", "version", "invalid-http", "timeout"]) {
      expect(await service.status()).toMatchObject({ reachable: false, state: "unknown" })
      expect(await service.updateIfRequired()).toMatchObject({ skipped: true, reason: "status_unknown" })
      await expect(service.initialize()).rejects.toThrow("服务状态暂无法核实")
      await expect(service.resume()).rejects.toThrow("服务状态暂无法核实")
      expect(await Bun.file(installed).text()).toBe("原程序")
      expect(await Bun.file(record).text()).toBe(saved)
    }
    expect(releaseCalls).toEqual([])
  } finally {
    listening.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("端口停止后先核进程记录，下载期间第三方抢占端口会保留已有文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-tuneweave-stopped-"))
  const free = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("unused") })
  const port = free.port, endpoint = free.url.origin
  free.stop(true)
  let manifestCalls = 0, occupied
  const service = new TuneWeaveService({
    root: directory, config: { api_url: endpoint }, spawn() { throw new Error("未证仍停止前不可启动") },
  })
  service.releaseManifest = async () => { manifestCalls++; return { version: "1.0.0-beta.4", artifacts: [] } }
  service.verifyInstalled = async () => false
  service.downloadRelease = async () => {
    const file = join(directory, "downloaded")
    await writeFile(file, "测试程序")
    occupied = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("other local service") })
    return { file, version: "1.0.0-beta.4" }
  }
  try {
    const record = join(directory, "process.json")
    const wrongEndpoint = JSON.stringify({ pid: 2147483647, api_url: "http://127.0.0.1:1" })
    await writeFile(record, wrongEndpoint)
    await mkdir(join(directory, "bin"))
    await writeFile(service.executable, "原程序")
    expect(await service.status()).toMatchObject({ reachable: false, state: "stopped" })
    expect(await service.updateIfRequired()).toMatchObject({ skipped: true, reason: "not_running" })
    await expect(service.initialize()).rejects.toThrow("进程记录与当前实例不一致")
    expect(manifestCalls).toBe(0)
    expect(await Bun.file(record).text()).toBe(wrongEndpoint)

    const saved = JSON.stringify({ pid: 2147483647, api_url: endpoint })
    await writeFile(record, saved)
    await expect(service.initialize()).rejects.toThrow("端点状态已变化")
    expect(manifestCalls).toBe(1)
    expect(await Bun.file(service.executable).text()).toBe("原程序")
    expect(await Bun.file(record).text()).toBe(saved)
    expect(await Bun.file(join(directory, "downloaded")).exists()).toBe(false)
  } finally {
    occupied?.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test("本地服务版本过低只提示初始化，不在开机检查时升级", async () => {
  let activate
  const notices = []
  const disconnect = new AbortController()
  const maintenance = startMediaMaintenance({ mediaRuntime: {
    disconnect: disconnect.signal,
    whenReady(start) { activate = start; return () => {} },
    async notifyMasters(message) { notices.push(message) },
  } }, {
    async load() { return {} },
    createTune: () => ({ localUrl: () => new URL("http://127.0.0.1"), async resume() {},
      async status() { return { ok: true, requiresUpdate: true } } }),
    async prepareTools() { return { ok: true, items: [] } },
    async wait(ms, signal) { if (ms) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })) },
  })
  activate()
  expect(await maintenance.waitForFirstRound(disconnect.signal)).toBe("failed")
  for (let i = 0; i < 10 && !notices.length; i++) await Bun.sleep(1)
  expect(notices.join("\n")).toContain("TuneWeave。请运行 bun run bootstrap")
  await maintenance.dispose()
})
