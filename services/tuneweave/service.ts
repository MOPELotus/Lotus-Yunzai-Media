import fs from "node:fs/promises"
import { createWriteStream, createReadStream } from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn, execFile, type ChildProcess, type SpawnOptions } from "node:child_process"
import { promisify } from "node:util"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import http from "node:http"
import https from "node:https"
import { setTimeout as sleep } from "node:timers/promises"
import { TUNEWEAVE_REQUIRED_VERSION, compareTuneWeaveVersions } from "./version.ts"
import { resolveData } from "../../core/path.ts"

export const TUNEWEAVE_MANIFEST_URL = "https://raw.githubusercontent.com/MOPELotus/TuneWeave/main/release-manifest.json"
const operations = new Map<string, Promise<unknown>>()
const runFile = promisify(execFile)
const platformStatus = {
  bilibili: {
    capabilities: ["qr_login", "account_profile", "search_videos", "video_detail", "video_parts", "video_playback_manifest"],
    ready: "B 站搜索、解析、播放与登录可用",
  },
  netease: {
    capabilities: ["platform_api", "qr_login", "account_profile", "caller_managed_credentials"],
    ready: "网易云登录与扩展 API 可用",
  },
}

export type TuneWeavePlatform = keyof typeof platformStatus

export interface TuneWeaveConfig {
  api_url: string
  request_timeout_ms: number
}

interface TuneWeaveOptions {
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  spawn?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess
  root?: string
  config?: Partial<TuneWeaveConfig>
  platform?: string
  arch?: string
}

export interface CredentialUpdate {
  platform: string
  credential: string
}

export interface TuneWeaveAccountSelection {
  platform: string
  alias?: string
  hasCredential?: boolean
}

export interface TuneWeaveRequestOptions {
  method?: string
  body?: unknown
  audio?: { readonly bytes: Uint8Array; readonly contentType: string }
  credentials?: readonly string[]
  onCredentialUpdates?: (updates: CredentialUpdate[]) => void | Promise<void>
  accountSelection?: TuneWeaveAccountSelection
  signal?: AbortSignal
  redirect?: RequestRedirect
}

interface TuneWeaveResponse<T> {
  ok?: boolean
  data: T
  error?: { code?: string; platform?: string; details?: { upstream_code?: number } }
  meta?: { platform?: string; account?: string; pagination?: unknown }
}

interface SelectedResponse<T> {
  data: T
  accountSelected: boolean
  pagination?: unknown
}

interface TuneWeaveCapability {
  platform: string
  registered: boolean
  capabilities: string[]
}

interface TuneWeaveReachableStatus {
  ok: boolean
  reachable: true
  version: string
  requiredVersion: string
  requiresUpdate: boolean
  apiUrl: string
  capabilities: TuneWeaveCapability[]
  message: string
}

interface TuneWeaveUnreachableStatus {
  ok: false
  reachable: false
  version?: never
  requiresUpdate?: never
  apiUrl: string
  message: string
}

export type TuneWeaveStatus = TuneWeaveReachableStatus | TuneWeaveUnreachableStatus

interface TuneWeaveArtifact {
  platform: string
  architecture: string
  download_url: string
  verification: { algorithm: string; checksum_url: string }
}

interface TuneWeaveManifest {
  version: string
  artifacts: TuneWeaveArtifact[]
  api_version?: unknown
  compatibility_profiles?: unknown
}

class TuneWeaveCompatibilityError extends Error {}

function requireCompatibleManifest(manifest: TuneWeaveManifest) {
  if (!manifest || typeof manifest.version !== "string" || !Array.isArray(manifest.artifacts)) {
    throw new TuneWeaveCompatibilityError("TuneWeave 发布清单格式无效")
  }
  if (!Object.hasOwn(manifest, "compatibility_profiles")) {
    if (manifest.version.replace(/^v/u, "") === "1.0.0-beta.3" &&
        (manifest.api_version === undefined || manifest.api_version === "v1")) return
    throw new TuneWeaveCompatibilityError("此 TuneWeave 发行版未声明客户端兼容性")
  }
  const profiles = manifest.compatibility_profiles
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 16 ||
      profiles.some(profile => typeof profile !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(profile)) ||
      new Set(profiles).size !== profiles.length) {
    throw new TuneWeaveCompatibilityError("TuneWeave 发布清单的客户端兼容性声明无效")
  }
  if (!profiles.includes("tuneweave-http-v1")) {
    throw new TuneWeaveCompatibilityError("此 TuneWeave 发行版与当前媒体客户端不兼容")
  }
}

interface TuneWeaveRelease {
  file: string
  version: string
}

interface ProcessIdentity {
  executable: string
  started: string | undefined
}

interface ProcessState {
  pid: number
  api_url: string
  identity?: ProcessIdentity | null
}

type Notify = (text: string) => void | Promise<void>

interface UpdateOptions {
  signal?: AbortSignal
  notify?: Notify
  status?: TuneWeaveStatus
  manifest?: TuneWeaveManifest
  repair?: boolean
  platform?: TuneWeavePlatform
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined
}

function errorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "未知错误"
}

export class TuneWeaveService {
  readonly fetch: NonNullable<TuneWeaveOptions["fetch"]>
  readonly spawn: NonNullable<TuneWeaveOptions["spawn"]>
  readonly root: string
  readonly config: TuneWeaveConfig
  readonly platform: string
  readonly arch: string

  constructor(options: TuneWeaveOptions = {}) {
    this.fetch = options.fetch || globalThis.fetch
    this.spawn = options.spawn || spawn
    this.root = options.root || resolveData("tuneweave")
    this.config = { api_url: "http://127.0.0.1:7832", request_timeout_ms: 30000, ...options.config }
    this.platform = options.platform || process.platform
    this.arch = options.arch || process.arch
  }

  request<T = unknown>(route: string, options: TuneWeaveRequestOptions & { accountSelection: TuneWeaveAccountSelection }): Promise<SelectedResponse<T>>
  request<T = unknown>(route: string, options?: TuneWeaveRequestOptions & { accountSelection?: undefined }): Promise<T>
  request<T = unknown>(route: string, options: TuneWeaveRequestOptions): Promise<T | SelectedResponse<T>>
  async request<T>(route: string, { method = "GET", body, audio, credentials = [], onCredentialUpdates, accountSelection, signal, redirect }: TuneWeaveRequestOptions = {}) {
    signal?.throwIfAborted()
    const target = `${this.config.api_url.replace(/\/+$/, "")}${route}`
    const timeout = AbortSignal.timeout(this.config.request_timeout_ms)
    if (audio && (body !== undefined || credentials.length || method !== "POST" || redirect !== "error")) throw new Error("音频上传请求无效")
    const headers: Record<string, string> = audio ? { "Content-Type": audio.contentType } : body === undefined ? {} : { "Content-Type": "application/json" }
    const options = {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(redirect && { redirect }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }
    const response = await (credentials.length ? requestCredentialJson(target, { ...options, credentials }) : this.fetch(target, {
      ...options, ...(audio && { body: Buffer.from(audio.bytes) }),
    }))
      .catch(() => {
        signal?.throwIfAborted()
        throw Object.assign(new Error("TuneWeave 无法连接，请先发送 #初始化环境 或检查服务状态。"), {
          code: "tuneweave_unavailable",
        })
      })
    const updates = String(response.headers?.get("X-TuneWeave-Updated-Credential") || "").split(",").map(value => value.trim()).filter(Boolean).map(value => {
      const split = value.indexOf("="); return { platform: value.slice(0, split), credential: value.slice(split + 1) }
    }).filter(item => /^[a-z]+$/.test(item.platform) && item.credential.startsWith("twc1_"))
    if (updates.length) await onCredentialUpdates?.(updates)
    let json: TuneWeaveResponse<T> | null
    try { json = await response.json() as TuneWeaveResponse<T> | null } catch { throw new Error("TuneWeave 返回了无效响应。") }
    if (!response.ok || json?.ok !== true) {
      const code = json?.error?.code || `HTTP ${response.status}`
      // Never expose upstream payloads, login cookies or credentials in chat/logs.
      const reason = json?.error?.details?.upstream_code === 405 ? "网易云今日没有更多可评定歌曲（405）" : code
      throw Object.assign(new Error(`TuneWeave 请求失败：${reason}`), {
        code, platform: json?.error?.platform,
        ...(json?.error?.details?.upstream_code === 405 && { upstreamCode: 405 }),
      })
    }
    if (accountSelection) {
      const { platform, alias, hasCredential } = accountSelection
      const accountSelected = hasCredential ? updates.some(item => item.platform === platform) :
        Boolean(alias && json.meta?.platform === platform && json.meta.account === alias)
      return { data: json.data, accountSelected, ...(json.meta?.pagination !== undefined && { pagination: json.meta.pagination }) }
    }
    return json.data
  }

  async status(platform: TuneWeavePlatform = "bilibili", signal?: AbortSignal, redirect?: RequestRedirect): Promise<TuneWeaveStatus> {
    const expected = platformStatus[platform]
    if (!Object.hasOwn(platformStatus, platform)) throw new Error("不支持此 TuneWeave 能力检查。")
    try {
      const health = await this.request<{ version: string }>("/healthz", { signal, redirect })
      const capabilities = await this.request<TuneWeaveCapability[]>("/v1/capabilities?" + new URLSearchParams({ platform }), { signal, redirect })
      const registration = Array.isArray(capabilities) ? capabilities.find(item => item.platform === platform && item.registered) : null
      const registered = registration?.capabilities
      const ready = Array.isArray(registered) && expected.capabilities.every(capability => registered.includes(capability))
      const requiresUpdate = compareTuneWeaveVersions(health.version, TUNEWEAVE_REQUIRED_VERSION) < 0
      return { ok: ready, reachable: true, version: health.version, requiredVersion: TUNEWEAVE_REQUIRED_VERSION, requiresUpdate, apiUrl: this.config.api_url, capabilities,
        message: requiresUpdate ? `低于插件最低要求 ${TUNEWEAVE_REQUIRED_VERSION}，等待开机延迟更新或发送 #初始化环境。` : ready ? expected.ready : "当前版本缺少所需能力，请升级 TuneWeave。" }
    } catch (error) {
      signal?.throwIfAborted()
      return { ok: false, reachable: false, apiUrl: this.config.api_url, message: errorMessage(error) }
    }
  }

  async requireReady(platform: TuneWeavePlatform, signal?: AbortSignal) {
    const status = await this.status(platform, signal)
    if (!status.ok) throw new Error(status.message)
    if (compareTuneWeaveVersions(status.version, TUNEWEAVE_REQUIRED_VERSION) < 0) throw new Error(`TuneWeave ${status.version} 低于要求 ${TUNEWEAVE_REQUIRED_VERSION}，请等待开机延迟更新或发送 #初始化环境`)
    return status
  }

  async publicDownload(url: string, timeoutMs = 60000, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const deadline = AbortSignal.timeout(timeoutMs)
    try {
      return await this.fetch(url, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline })
    } catch {
      signal?.throwIfAborted()
      // Public release files only. curl honors deployment proxy settings on
      // Node versions where fetch does not; account requests never use this.
      const { stdout } = await runFile("curl", ["--fail", "--location", "--silent", "--show-error", "--retry", "3", "--retry-all-errors", "--connect-timeout", "15", "--max-time", String(Math.ceil(timeoutMs / 1000)), url], {
        encoding: "buffer", maxBuffer: 128 * 1024 * 1024, windowsHide: true, signal,
      }).catch(() => { throw new Error("TuneWeave 官方发布文件下载失败，请检查网络/代理；网络受限时需要可用的 curl。") })
      return new Response(stdout)
    }
  }

  get executable() { return path.join(this.root, "bin", this.platform === "win32" ? "tuneweave.exe" : "tuneweave") }

  async lifecycle<T>(work: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.root), previous = operations.get(key) || Promise.resolve()
    const current = previous.catch(() => {}).then(work)
    operations.set(key, current)
    try { return await current } finally { if (operations.get(key) === current) operations.delete(key) }
  }

  localUrl() {
    const url = new URL(this.config.api_url)
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("远程 TuneWeave 请自行升级；自动安装与重启只支持本机、由本插件管理的实例。")
    }
    return url
  }

  async initialize({ onProgress = async () => {}, platform = "bilibili", signal }: {
    onProgress?: Notify; platform?: TuneWeavePlatform; signal?: AbortSignal
  } = {}) {
    return this.lifecycle(async () => {
      signal?.throwIfAborted()
      const status = await this.status(platform, signal, signal ? "error" : undefined)
      try { this.localUrl() } catch {
        if (!status.ok || status.requiresUpdate) throw new Error(status.message)
        return { ...status, already: true }
      }
      try {
        const manifest = await this.releaseManifest(signal)
        if (status.reachable) {
          const comparison = compareTuneWeaveVersions(status.version, manifest.version)
          const intact = comparison > 0 || comparison === 0 && await this.verifyInstalled(manifest, signal)
          if (comparison < 0 || !intact) return await this.updateInstalled({ notify: onProgress, status, manifest, platform, signal, repair: !intact && comparison === 0 })
          if (!status.ok) throw new Error(status.message)
          return { ...status, already: true }
        }
        this.localUrl()
        if (!await this.verifyInstalled(manifest, signal)) {
          await onProgress("正在下载 TuneWeave 官方发布文件并校验 SHA-256。")
          const release = await this.downloadRelease(manifest, signal)
          let backup = null
          const previous = `${this.executable}.previous-${crypto.randomUUID()}`
          try {
            signal?.throwIfAborted()
            try { await fs.rename(this.executable, previous); backup = previous } catch (error) { if (errorCode(error) !== "ENOENT") throw error }
            await fs.rename(release.file, this.executable)
            const ready = await this.startInstalled(release.version, platform, signal)
            if (backup) await fs.rm(backup, { force: true })
            return { ...ready, installed: true }
          } catch (error) {
            if (backup) {
              await fs.rename(backup, this.executable)
              try { await this.startInstalled(undefined, platform) } catch {}
            }
            throw error
          } finally { await fs.rm(release.file, { force: true }) }
        }
        await onProgress("正在启动本机 TuneWeave 服务。")
        const ready = await this.startInstalled(undefined, platform, signal)
        if (compareTuneWeaveVersions(ready.version, manifest.version) < 0) return await this.updateInstalled({ notify: onProgress, status: ready, manifest, platform, signal })
        return { ...ready, installed: false }
      } catch (error) {
        // Update/verification availability is separate from service readiness.
        // Never accept an unhealthy service or one below the required version.
        signal?.throwIfAborted()
        const current = await this.status(platform, signal, signal ? "error" : undefined)
        if (!current.ok || compareTuneWeaveVersions(current.version, TUNEWEAVE_REQUIRED_VERSION) < 0) throw error
        const message = error instanceof TuneWeaveCompatibilityError ? error.message + "，已保留现有服务。"
          : "现有 TuneWeave 服务可用，联网更新或校验暂未完成，稍后重试。"
        return { ...current, already: true, updateDeferred: true, message }
      }
    })
  }

  async releaseManifest(signal?: AbortSignal) {
    const response = await this.publicDownload(TUNEWEAVE_MANIFEST_URL, undefined, signal)
    if (!response.ok) throw new Error(`TuneWeave 版本清单下载失败：HTTP ${response.status}`)
    const manifest: TuneWeaveManifest = await response.json()
    requireCompatibleManifest(manifest)
    if (compareTuneWeaveVersions(manifest.version, TUNEWEAVE_REQUIRED_VERSION) < 0) throw new Error(`发布包 ${manifest.version} 低于要求 ${TUNEWEAVE_REQUIRED_VERSION}`)
    return manifest
  }

  async releaseChecksum(manifest: TuneWeaveManifest, signal?: AbortSignal) {
    const artifact = selectTuneWeaveArtifact(manifest, this.platform, this.arch)
    const response = await this.publicDownload(artifact.verification.checksum_url, undefined, signal)
    if (!response.ok) throw new Error("TuneWeave 校验文件下载失败")
    const checksum = (await response.text()).trim().split(/\s+/)[0]?.toLowerCase() || ""
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("TuneWeave 校验文件无效")
    return checksum
  }

  async verifyInstalled(manifest: TuneWeaveManifest, signal?: AbortSignal) {
    try { await fs.access(this.executable) } catch (error) { if (errorCode(error) === "ENOENT") return false; throw error }
    const expected = await this.releaseChecksum(manifest, signal), hash = crypto.createHash("sha256")
    for await (const chunk of createReadStream(this.executable, { signal })) hash.update(chunk)
    return hash.digest("hex") === expected
  }

  async downloadRelease(manifest?: TuneWeaveManifest, signal?: AbortSignal): Promise<TuneWeaveRelease> {
    signal?.throwIfAborted()
    if (manifest) requireCompatibleManifest(manifest)
    else manifest = await this.releaseManifest(signal)
    const artifact = selectTuneWeaveArtifact(manifest, this.platform, this.arch)
    await fs.mkdir(path.dirname(this.executable), { recursive: true })
    const file = `${this.executable}.download-${crypto.randomUUID()}`
    try {
      const [download, checksumResponse] = await Promise.all([
        this.publicDownload(artifact.download_url, 180000, signal),
        this.publicDownload(artifact.verification.checksum_url, undefined, signal),
      ])
      if (!download.ok || !checksumResponse.ok || !download.body) throw new Error("TuneWeave 下载失败")
      const checksum = (await checksumResponse.text()).trim().split(/\s+/)[0]?.toLowerCase() || ""
      if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("TuneWeave 校验文件无效")
      const hash = crypto.createHash("sha256")
      // Bun's Web Stream declaration adds helpers that Node's runtime bridge does not use.
      const stream = Readable.fromWeb(download.body as unknown as Parameters<typeof Readable.fromWeb>[0])
      stream.on("data", chunk => hash.update(chunk))
      await pipeline(stream, createWriteStream(file, { mode: 0o700, flags: "wx" }), { signal })
      if (hash.digest("hex") !== checksum) throw new Error("TuneWeave SHA-256 校验不匹配")
      await fs.chmod(file, 0o700)
      return { file, version: manifest.version }
    } catch (error) { await fs.rm(file, { force: true }); throw error }
  }

  async startInstalled(expectedVersion: string | undefined, platform: TuneWeavePlatform = "bilibili", signal?: AbortSignal) {
    signal?.throwIfAborted()
    const url = this.localUrl()
    let recorded = false
    try { await fs.access(path.join(this.root, "process.json")); recorded = true } catch (error) { if (errorCode(error) !== "ENOENT") throw error }
    if (recorded && (await this.managedProcess()).alive) throw new Error("TuneWeave 托管进程仍在运行，保留当前进程记录，请先确认健康状态")
    await fs.mkdir(path.join(this.root, "accounts"), { recursive: true, mode: 0o700 })
    const log = await fs.open(path.join(this.root, "server.log"), "a", 0o600)
    let child: ChildProcess
    try {
      signal?.throwIfAborted()
      child = this.spawn(this.executable, [], {
        cwd: this.root, detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd],
        env: { ...process.env, TUNEWEAVE_BIND: `${url.hostname === "localhost" ? "127.0.0.1" : url.hostname}:${url.port || "80"}`, TUNEWEAVE_DATA_DIR: path.join(this.root, "accounts"), TUNEWEAVE_LOG_DIR: path.join(this.root, "logs") },
      })
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject) })
      child.unref()
    } finally { await log.close() }
    const pid = child.pid
    if (pid === undefined) throw new Error("TuneWeave 托管进程缺少进程编号")
    await fs.writeFile(path.join(this.root, "process.json"), JSON.stringify({ pid, api_url: this.config.api_url, identity: await processIdentity(pid, this.platform).catch(() => null) }), { mode: 0o600 })
    try {
      for (let i = 0; i < 30; i++) {
        await sleep(1000, undefined, { signal })
        if (child.exitCode !== null || child.signalCode !== null) break
        const ready = await this.status(platform, signal, "error")
        if (ready.ok) {
          if (expectedVersion && compareTuneWeaveVersions(ready.version, expectedVersion) !== 0) throw new Error("TuneWeave 启动后的版本与校验发布包不符")
          await sleep(100, undefined, { signal })
          if (child.exitCode !== null || child.signalCode !== null || !await processAlive(pid)) throw new Error("TuneWeave 子进程已退出")
          return { ...ready, pid }
        }
        if (ready.reachable) throw new Error(ready.message)
      }
      throw new Error("TuneWeave 启动未通过健康检查，请查看 data/tuneweave/server.log。")
    } catch (error) {
      // Only terminate the child created by this start attempt.
      if (await processAlive(pid)) await this.stopManaged(pid)
      throw error
    }
  }

  async managedProcess() {
    this.localUrl()
    let state: ProcessState
    try { state = JSON.parse(await fs.readFile(path.join(this.root, "process.json"), "utf8")) } catch { throw new Error("没有本插件的 TuneWeave 进程记录，请由部署方升级服务") }
    if (!Number.isInteger(state.pid) || state.pid <= 0 || new URL(state.api_url).href !== new URL(this.config.api_url).href) throw new Error("TuneWeave 进程记录与当前实例不一致")
    if (!await processAlive(state.pid)) return { ...state, alive: false }
    const actual = await processIdentity(state.pid, this.platform), executable = await fs.realpath(this.executable).catch(error => {
      if (errorCode(error) === "ENOENT" && state.identity?.executable === path.resolve(this.executable)) return state.identity.executable
      throw error
    })
    const samePath = this.platform === "win32" ? actual.executable.toLowerCase() === executable.toLowerCase() : actual.executable === executable
    if (!samePath || state.identity && (state.identity.executable !== actual.executable || state.identity.started !== actual.started)) throw new Error("TuneWeave 进程身份不匹配，保留当前服务，请由部署方检查")
    return { ...state, identity: actual, alive: true }
  }

  async stopManaged(expectedPid?: number) {
    const state = await this.managedProcess()
    if (expectedPid && state.pid !== expectedPid) throw new Error("TuneWeave 进程已变化，取消重启")
    if (state.alive) {
      process.kill(state.pid, "SIGTERM")
      for (let i = 0; i < 100 && await processAlive(state.pid); i++) await sleep(100)
      if (await processAlive(state.pid)) {
        // Recheck identity before terminating a process that did not shut down.
        await this.managedProcess()
        process.kill(state.pid, "SIGKILL")
        for (let i = 0; i < 50 && await processAlive(state.pid); i++) await sleep(100)
      }
      if (await processAlive(state.pid)) throw new Error("TuneWeave 旧进程未停止，取消替换程序")
    }
    await fs.rm(path.join(this.root, "process.json"), { force: true })
  }

  async updateIfRequired({ notify = async () => {} }: { notify?: Notify } = {}) {
    return this.lifecycle(() => this.updateInstalled({ notify }))
  }

  async updateInstalled({ notify, status, manifest, repair = false, platform = "bilibili", signal }: UpdateOptions = {}) {
    signal?.throwIfAborted()
    status ||= await this.status(platform, signal, signal ? "error" : undefined)
    if (!status.reachable) return { ...status, skipped: true, reason: "not_running" }
    const targetVersion = manifest?.version || TUNEWEAVE_REQUIRED_VERSION
    if (!repair && compareTuneWeaveVersions(status.version, targetVersion) >= 0) return { ...status, skipped: true, reason: "up_to_date" }
    const state = await this.managedProcess()
    if (!state.alive) throw new Error("TuneWeave 托管进程未运行，取消自动替换")
    const send = async (message: string) => {
      try { await notify?.(message) } catch (error) {
        const logger = (globalThis as typeof globalThis & { logger?: { warn?: (text: string) => void } }).logger
        logger?.warn?.(`[media] TuneWeave 更新通知失败：${errorMessage(error)}`)
      }
    }
    await send(`TuneWeave 当前 ${status.version}，正在${repair ? "修复" : "更新至"} ${targetVersion}；下载校验后自动重启服务。`)
    let release: TuneWeaveRelease | undefined, backup: string | null | undefined, replaced = false, stopped = false
    try {
      release = await this.downloadRelease(manifest, signal)
      if ((await this.managedProcess()).pid !== state.pid) throw new Error("下载期间 TuneWeave 进程已变化，取消更新")
      signal?.throwIfAborted()
      try { await this.stopManaged(state.pid); stopped = true }
      catch (error) { stopped = !await processAlive(state.pid); throw error }
      backup = `${this.executable}.previous-${crypto.randomUUID()}`
      try { await fs.rename(this.executable, backup) } catch (error) { if (errorCode(error) === "ENOENT") backup = null; else throw error }
      try { await fs.rename(release.file, this.executable); replaced = true }
      catch (error) { if (backup) await fs.rename(backup, this.executable); backup = null; throw error }
      const ready = await this.startInstalled(release.version, platform, signal)
      if (backup) await fs.rm(backup, { force: true }); backup = null
      await send(`TuneWeave 已从 ${status.version} 更新至 ${ready.version}，服务已自动重启并通过健康与能力检查。`)
      return { ...ready, updated: true, previousVersion: status.version }
    } catch (error) {
      let recovery = "旧服务保持运行"
      if (stopped) {
        try {
          if (replaced && backup) {
            // A failed start normally already stopped its child.
            try { const current = await this.managedProcess(); if (current.alive) await this.stopManaged(current.pid) } catch (checkError) {
              if (!/没有本插件/.test(errorMessage(checkError))) throw checkError
            }
            await fs.rm(this.executable, { force: true })
            await fs.rename(backup, this.executable); backup = null
          }
          await this.startInstalled(status.version, platform)
          recovery = `已恢复 ${status.version} 并重新启动`
        } catch (rollbackError) { recovery = `恢复旧服务失败：${errorMessage(rollbackError)}` }
      }
      await send(`TuneWeave 更新失败：${errorMessage(error)}；${recovery}。`)
      throw Object.assign(new Error(`TuneWeave 更新失败：${errorMessage(error)}；${recovery}`), { notified: true })
    } finally {
      if (release) await fs.rm(release.file, { force: true })
    }
  }

  async resume(signal?: AbortSignal) {
    // Resume existing installations without downloading or updating at boot.
    signal?.throwIfAborted()
    try { this.localUrl() } catch { return { skipped:true } }
    try {
      const [state, binary] = await Promise.all([
        fs.lstat(path.join(this.root, "process.json")), fs.lstat(this.executable),
      ])
      if (!state.isFile() || !binary.isFile()) return { skipped:true }
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { skipped:true }
      throw error
    }
    return this.lifecycle(async () => {
      signal?.throwIfAborted()
      await this.managedProcess()
      const status = await this.status("bilibili", signal, "error")
      if (status.reachable) return status
      return this.startInstalled(undefined, "bilibili", signal)
    })
  }

}

// Node's fetch combines repeated header values. TuneWeave accepts one opaque
// credential per header, so use native HTTP for authenticated multi-source calls.
interface CredentialRequestOptions {
  method: string
  headers: http.OutgoingHttpHeaders
  body?: string
  signal: AbortSignal
  credentials: readonly string[]
}

type JsonResponse = Pick<Response, "ok" | "status" | "headers"> & { json(): Promise<unknown> }

function requestCredentialJson(target: string, { method, headers, body, signal, credentials }: CredentialRequestOptions): Promise<JsonResponse> {
  if (credentials.length > 8 || credentials.some(value => typeof value !== "string" || !value.startsWith("twc1_") || value.length > 65536 || /[\r\n]/.test(value))) throw new Error("TuneWeave 凭据格式无效")
  const url = new URL(target), transport = url.protocol === "https:" ? https : http
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method, headers: { ...headers, "X-TuneWeave-Credential": [...credentials] }, signal }, response => {
      const chunks: Buffer[] = []; let bytes = 0
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) response.destroy(new Error("TuneWeave 响应过大")); else chunks.push(chunk) })
      response.on("error", reject); response.on("aborted", () => reject(new Error("TuneWeave 响应中断")))
      response.on("end", () => { const resultHeaders = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) resultHeaders.set(key, Array.isArray(value) ? value.join(",") : value)
        const status = response.statusCode ?? 0
        resolve({ ok: status >= 200 && status < 300, status, headers: resultHeaders, json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")) }) })
    })
    request.on("error", reject); request.end(body)
  })
}

const releasePlatforms: Partial<Record<string, string>> = { linux: "linux", win32: "windows", darwin: "macos" }
const releaseArchitectures: Partial<Record<string, string>> = { x64: "x86_64", arm64: "aarch64" }

export function selectTuneWeaveArtifact(manifest: TuneWeaveManifest, platform: string, arch: string) {
  const system = releasePlatforms[platform]
  const architecture = releaseArchitectures[arch]
  const artifact = manifest?.artifacts?.find(item => item.platform === system && item.architecture === architecture)
  if (!artifact || artifact.verification?.algorithm !== "sha256") throw new Error(`TuneWeave 暂无 ${platform}/${arch} 的预编译文件，请自行部署。`)
  const releasePath = `/MOPELotus/TuneWeave/releases/download/v${manifest.version.replace(/^v/u, "")}/`
  for (const value of [artifact.download_url, artifact.verification.checksum_url]) {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/MOPELotus/TuneWeave/releases/download/")) throw new Error("TuneWeave 下载地址不属于官方发布仓库。")
    if (!url.pathname.startsWith(releasePath)) throw new Error("TuneWeave 发布清单版本与下载地址不一致")
  }
  return artifact
}

async function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    if (process.platform === "linux") {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return false
    }
    return true
  } catch (error) { if (["ESRCH", "ENOENT"].includes(errorCode(error) ?? "")) return false; throw error }
}

async function processIdentity(pid: number, platform: string): Promise<ProcessIdentity> {
  if (platform === "linux") {
    const [file, stat] = await Promise.all([fs.readlink(`/proc/${pid}/exe`), fs.readFile(`/proc/${pid}/stat`, "utf8")])
    return { executable: file.replace(/ \(deleted\)$/, ""), started: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] }
  }
  if (platform === "win32") {
    const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p=Get-Process -Id ${pid} -ErrorAction Stop; Write-Output $p.Path; Write-Output $p.StartTime.ToUniversalTime().Ticks`], { timeout: 15000, windowsHide: true })
    const [executable, started] = stdout.trim().split(/\r?\n/)
    if (!executable) throw new Error("无法识别 TuneWeave 托管进程路径")
    return { executable: await fs.realpath(executable), started }
  }
  if (platform === "darwin") {
    const [file, birth] = await Promise.all([runFile("ps", ["-p", String(pid), "-o", "comm="], { timeout: 15000 }), runFile("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 15000 })])
    return { executable: await fs.realpath(file.stdout.trim()), started: birth.stdout.trim() }
  }
  throw new Error("当前系统无法核验 TuneWeave 托管进程身份，请手动升级")
}
