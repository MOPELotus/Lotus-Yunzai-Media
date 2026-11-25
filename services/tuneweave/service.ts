import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { withoutReadRetries, withReadRetries } from "@lotus-yunzai/http"
import { ReleaseHttpError, retryReleaseRequest, temporaryReleaseFailure, releaseFailure } from "../release-network.ts"
import { emitTaskProgress, responseBytes, type TaskProgressHandler } from "../progress.ts"
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
    ready: $t("services.tuneweave.service.text_57a6783ba7"),
  },
  netease: {
    capabilities: ["platform_api", "qr_login", "account_profile", "caller_managed_credentials"],
    ready: $t("services.tuneweave.service.text_7025333280"),
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
  error?: { code?: string; platform?: string; details?: { upstream_code?: number; upstream_response_empty?: boolean; android_search_empty?: boolean } }
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
  state: "stopped" | "unknown"
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
    throw new TuneWeaveCompatibilityError($t("services.tuneweave.service.text_437634685c"))
  }
  if (!Object.hasOwn(manifest, "compatibility_profiles")) {
    if (manifest.version.replace(/^v/u, "") === "1.0.0-beta.3" &&
        (manifest.api_version === undefined || manifest.api_version === "v1")) return
    throw new TuneWeaveCompatibilityError($t("services.tuneweave.service.text_b87521b340"))
  }
  const profiles = manifest.compatibility_profiles
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 16 ||
      profiles.some(profile => typeof profile !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(profile)) ||
      new Set(profiles).size !== profiles.length) {
    throw new TuneWeaveCompatibilityError($t("services.tuneweave.service.text_b9f136d4ae"))
  }
  if (!profiles.includes("tuneweave-http-v1")) {
    throw new TuneWeaveCompatibilityError($t("services.tuneweave.service.text_26407ed810"))
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
  onTaskProgress?: TaskProgressHandler
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

function isConnectionRefused(error: unknown): boolean {
  if (errorCode(error) === "ECONNREFUSED") return true
  return error instanceof AggregateError && error.errors.length > 0 && error.errors.every(isConnectionRefused)
}

function errorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : $t("services.tuneweave.service.text_13a46616e1")
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
    if (audio && (body !== undefined || credentials.length || method !== "POST" || redirect !== "error")) throw new Error($t("services.tuneweave.service.text_265c349658"))
    const headers: Record<string, string> = audio ? { "Content-Type": audio.contentType } : body === undefined ? {} : { "Content-Type": "application/json" }
    const options = {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(redirect && { redirect }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }
    const response = await (credentials.length ? requestCredentialJson(target, { ...options, credentials }) : withReadRetries((url, init) => withoutReadRetries(() => this.fetch(url.href, init)), {
      canRetry: (url, verb) => verb === "GET" && body === undefined && !audio &&
        ["/healthz", "/v1/capabilities", "/v1/search"].includes(url.pathname),
    })(new URL(target), { ...options, ...(audio && { body: Buffer.from(audio.bytes) }) }))
      .catch((cause: unknown) => {
        signal?.throwIfAborted()
        throw Object.assign(new Error($t("services.tuneweave.service.text_1d67d22789"), { cause }), {
          code: "tuneweave_unavailable",
        })
      })
    const updates = String(response.headers?.get("X-TuneWeave-Updated-Credential") || "").split(",").map(value => value.trim()).filter(Boolean).map(value => {
      const split = value.indexOf("="); return { platform: value.slice(0, split), credential: value.slice(split + 1) }
    }).filter(item => /^[a-z]+$/.test(item.platform) && item.credential.startsWith("twc1_"))
    if (updates.length) await onCredentialUpdates?.(updates)
    let json: TuneWeaveResponse<T> | null
    try { json = await response.json() as TuneWeaveResponse<T> | null } catch { throw new Error($t("services.tuneweave.service.text_3bd1b18635")) }
    if (!response.ok || json?.ok !== true) {
      const code = json?.error?.code || `HTTP ${response.status}`
      // Never expose upstream payloads, login cookies or credentials in chat/logs.
      const details = json?.error?.details
      const emptySodaSearch = response.status === 502 && json?.error?.platform === "soda" && route.startsWith("/v1/search?") &&
        (details?.upstream_response_empty === true || details?.android_search_empty === true)
      const reason = emptySodaSearch
        ? $t("services.tuneweave.service.text_1009e17022")
        : details?.upstream_code === 405 ? $t("services.tuneweave.service.text_be3b951a49") : code
      throw Object.assign(new Error($t("services.tuneweave.service.text_7be467bfba", { "reason": reason })), {
        code, platform: json?.error?.platform,
        ...(details?.upstream_code === 405 && { upstreamCode: 405 }),
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
    if (!Object.hasOwn(platformStatus, platform)) throw new Error($t("services.tuneweave.service.text_a741da1557"))
    let healthResponded = false
    try {
      const health = await this.request<{ version: string }>("/healthz", { signal, redirect })
      healthResponded = true
      const requiresUpdate = compareTuneWeaveVersions(health.version, TUNEWEAVE_REQUIRED_VERSION) < 0
      const capabilities = await this.request<TuneWeaveCapability[]>("/v1/capabilities?" + new URLSearchParams({ platform }), { signal, redirect })
      const registration = Array.isArray(capabilities) ? capabilities.find(item => item.platform === platform && item.registered) : null
      const registered = registration?.capabilities
      if (!Array.isArray(capabilities)) throw new Error($t("services.tuneweave.service.text_bb2281f199"))
      const ready = Array.isArray(registered) && expected.capabilities.every(capability => registered.includes(capability))
      return { ok: ready, reachable: true, version: health.version, requiredVersion: TUNEWEAVE_REQUIRED_VERSION, requiresUpdate, apiUrl: this.config.api_url, capabilities,
        message: requiresUpdate ? $t("services.tuneweave.service.text_7606f0e332", { "TUNEWEAVE_REQUIRED_VERSION": TUNEWEAVE_REQUIRED_VERSION }) : ready ? expected.ready : $t("services.tuneweave.service.text_b0cdc73397") }
    } catch (error) {
      signal?.throwIfAborted()
      const stopped = !healthResponded && errorCode(error) === "tuneweave_unavailable" &&
        error instanceof Error && isConnectionRefused(error.cause)
      return { ok: false, reachable: false, state: stopped ? "stopped" : "unknown", apiUrl: this.config.api_url,
        message: stopped ? $t("services.tuneweave.service.text_1d67d22789")
          : $t("services.tuneweave.service.text_6f4b845d92") }
    }
  }

  async requireReady(platform: TuneWeavePlatform, signal?: AbortSignal) {
    const status = await this.status(platform, signal)
    if (!status.ok) throw new Error(status.message)
    if (compareTuneWeaveVersions(status.version, TUNEWEAVE_REQUIRED_VERSION) < 0) throw new Error($t("services.tuneweave.service.text_de7d486d3c", { "version": status.version, "TUNEWEAVE_REQUIRED_VERSION": TUNEWEAVE_REQUIRED_VERSION }))
    return status
  }

  async publicDownload(url: string, timeoutMs = 60000, signal?: AbortSignal, onTaskProgress?: TaskProgressHandler, attempts = 3) {
    signal?.throwIfAborted()
    const label = url === TUNEWEAVE_MANIFEST_URL ? $t("services.tuneweave.service.text_14cd35445d")
      : url.endsWith(".sha256") ? $t("services.tuneweave.service.text_f25d32f8b6") : $t("services.tuneweave.service.text_9cbfc91b0a")
    try {
      return await retryReleaseRequest(async () => {
        const deadline = AbortSignal.timeout(timeoutMs)
        const response = await this.fetch(url, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline })
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new ReleaseHttpError(response.status) }
        return response
      }, { label, url, signal, onTaskProgress, attempts })
    } catch (error) {
      signal?.throwIfAborted()
      if (!temporaryReleaseFailure(error)) throw error
      // Public release files only. Respect deployment proxy settings in both transports.
      if (!Bun.which("curl")) throw error
      const host = new URL(url).host
      emitTaskProgress(onTaskProgress, { stage: "tuneweave-download-fallback", message: $t("services.tuneweave.service.text_2576b4a0ad", { "label": label, "host": host }) })
      const { stdout } = await runFile("curl", ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "15", "--max-time", String(Math.ceil(timeoutMs / 1000)), url], {
        encoding: "buffer", maxBuffer: 128 * 1024 * 1024, windowsHide: true, signal,
      }).catch((fallback: unknown) => {
        signal?.throwIfAborted()
        throw new Error($t("services.tuneweave.service.text_cd6609c0f6", { "label": label, "host": host, "value3": releaseFailure(error) }), { cause: fallback })
      })
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
      throw new Error($t("services.tuneweave.service.text_4c311060bf"))
    }
    return url
  }

  async initialize({ onProgress: notify, onTaskProgress, platform = "bilibili", signal }: {
    onProgress?: Notify; onTaskProgress?: TaskProgressHandler; platform?: TuneWeavePlatform; signal?: AbortSignal
  } = {}) {
    const onProgress = async (message: string) => {
      emitTaskProgress(onTaskProgress, { stage: "tuneweave", message })
      try { await notify?.(message) } catch {}
    }
    return this.lifecycle(async () => {
      emitTaskProgress(onTaskProgress, { stage: "tuneweave-check", message: $t("services.tuneweave.service.text_e53bf5ff33") })
      signal?.throwIfAborted()
      const status = await this.status(platform, signal, "error")
      try { this.localUrl() } catch {
        if (!status.ok || status.requiresUpdate) throw new Error(status.message)
        return { ...status, already: true }
      }
      if (!status.reachable) {
        if (status.state !== "stopped") throw new Error(status.message)
        await this.requireStoppedRecord()
      }
      try {
        const manifest = await this.releaseManifest(signal, onTaskProgress)
        if (status.reachable) {
          const comparison = compareTuneWeaveVersions(status.version, manifest.version)
          const intact = comparison > 0 || comparison === 0 && await this.verifyInstalled(manifest, signal, onTaskProgress)
          if (comparison < 0 || !intact) return await this.updateInstalled({ notify: onProgress, onTaskProgress, status, manifest, platform, signal, repair: !intact && comparison === 0 })
          if (!status.ok) throw new Error(status.message)
          return { ...status, already: true }
        }
        this.localUrl()
        if (!await this.verifyInstalled(manifest, signal, onTaskProgress)) {
          await onProgress($t("services.tuneweave.service.text_232cfe0169"))
          const release = await this.downloadRelease(manifest, signal, onTaskProgress)
          let backup: string | undefined, replaced = false
          const previous = `${this.executable}.previous-${crypto.randomUUID()}`
          try {
            await this.requireStoppedEndpoint(platform, signal)
            try { await fs.rename(this.executable, previous); backup = previous } catch (error) { if (errorCode(error) !== "ENOENT") throw error }
            await fs.rename(release.file, this.executable)
            replaced = true
            const ready = await this.startInstalled(release.version, platform, signal, onTaskProgress)
            if (backup) await fs.rm(backup, { force: true })
            return { ...ready, installed: true }
          } catch (error) {
            if (backup) {
              await fs.rename(backup, this.executable)
              try { await this.startInstalled(undefined, platform) } catch {}
            } else if (replaced) await fs.rm(this.executable, { force: true })
            throw error
          } finally { await fs.rm(release.file, { force: true }) }
        }
        await onProgress($t("services.tuneweave.service.text_fb1a6db440"))
        await this.requireStoppedEndpoint(platform, signal)
        const ready = await this.startInstalled(undefined, platform, signal, onTaskProgress)
        if (compareTuneWeaveVersions(ready.version, manifest.version) < 0) return await this.updateInstalled({ notify: onProgress, onTaskProgress, status: ready, manifest, platform, signal })
        return { ...ready, installed: false }
      } catch (error) {
        // Update/verification availability is separate from service readiness.
        // Never accept an unhealthy service or one below the required version.
        signal?.throwIfAborted()
        const current = await this.status(platform, signal, "error")
        if (!current.ok || compareTuneWeaveVersions(current.version, TUNEWEAVE_REQUIRED_VERSION) < 0) throw error
        const message = error instanceof TuneWeaveCompatibilityError ? error.message + $t("services.tuneweave.service.text_46936c26ac")
          : $t("services.tuneweave.service.text_1b884b1a83")
        return { ...current, already: true, updateDeferred: true, message }
      }
    })
  }

  async releaseManifest(signal?: AbortSignal, onTaskProgress?: TaskProgressHandler) {
    const response = await this.publicDownload(TUNEWEAVE_MANIFEST_URL, undefined, signal, onTaskProgress)
    if (!response.ok) throw new Error($t("services.tuneweave.service.text_4ec2c41bda", { "status": response.status }))
    const manifest: TuneWeaveManifest = await response.json()
    requireCompatibleManifest(manifest)
    if (compareTuneWeaveVersions(manifest.version, TUNEWEAVE_REQUIRED_VERSION) < 0) throw new Error($t("services.tuneweave.service.text_73861eabc7", { "version": manifest.version, "TUNEWEAVE_REQUIRED_VERSION": TUNEWEAVE_REQUIRED_VERSION }))
    return manifest
  }

  async releaseChecksum(manifest: TuneWeaveManifest, signal?: AbortSignal, onTaskProgress?: TaskProgressHandler) {
    const artifact = selectTuneWeaveArtifact(manifest, this.platform, this.arch)
    const response = await this.publicDownload(artifact.verification.checksum_url, undefined, signal, onTaskProgress)
    if (!response.ok) throw new Error($t("services.tuneweave.service.text_69c606f356"))
    const checksum = (await response.text()).trim().split(/\s+/)[0]?.toLowerCase() || ""
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error($t("services.tuneweave.service.text_d9be8b0d22"))
    return checksum
  }

  async verifyInstalled(manifest: TuneWeaveManifest, signal?: AbortSignal, onTaskProgress?: TaskProgressHandler) {
    try { await fs.access(this.executable) } catch (error) { if (errorCode(error) === "ENOENT") return false; throw error }
    const expected = await this.releaseChecksum(manifest, signal, onTaskProgress), hash = crypto.createHash("sha256")
    const total = (await fs.stat(this.executable)).size
    let completed = 0
    const report = () => emitTaskProgress(onTaskProgress, { stage: "tuneweave-verify", message: $t("services.tuneweave.service.text_38ba82b6d0"), completed, total, unit: "bytes" })
    report()
    for await (const chunk of createReadStream(this.executable, { signal })) { hash.update(chunk); completed += chunk.length; report() }
    return hash.digest("hex") === expected
  }

  async downloadRelease(manifest?: TuneWeaveManifest, signal?: AbortSignal, onTaskProgress?: TaskProgressHandler): Promise<TuneWeaveRelease> {
    signal?.throwIfAborted()
    manifest ||= await this.releaseManifest(signal, onTaskProgress)
    requireCompatibleManifest(manifest)
    const artifact = selectTuneWeaveArtifact(manifest, this.platform, this.arch)
    const selected = manifest
    return retryReleaseRequest(() => this.downloadReleaseOnce(selected, signal, onTaskProgress), {
      label: $t("services.tuneweave.service.text_d878ea1ff0"), url: artifact.download_url, signal, onTaskProgress,
    })
  }

  private async downloadReleaseOnce(manifest: TuneWeaveManifest, signal?: AbortSignal, onTaskProgress?: TaskProgressHandler): Promise<TuneWeaveRelease> {
    signal?.throwIfAborted()
    emitTaskProgress(onTaskProgress, { stage: "tuneweave-release", message: $t("services.tuneweave.service.text_37d295535d") })
    requireCompatibleManifest(manifest)
    const artifact = selectTuneWeaveArtifact(manifest, this.platform, this.arch)
    await fs.mkdir(path.dirname(this.executable), { recursive: true })
    const file = `${this.executable}.download-${crypto.randomUUID()}`
    try {
      const [download, checksumResponse] = await Promise.all([
        this.publicDownload(artifact.download_url, 180000, signal, onTaskProgress, 1),
        this.publicDownload(artifact.verification.checksum_url, undefined, signal, onTaskProgress, 1),
      ])
      if (!download.ok || !checksumResponse.ok || !download.body) throw new Error($t("services.tuneweave.service.text_27ebdb367f"))
      const checksum = (await checksumResponse.text()).trim().split(/\s+/)[0]?.toLowerCase() || ""
      if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error($t("services.tuneweave.service.text_d9be8b0d22"))
      const hash = crypto.createHash("sha256")
      // Bun's Web Stream declaration adds helpers that Node's runtime bridge does not use.
      const stream = Readable.fromWeb(download.body as unknown as Parameters<typeof Readable.fromWeb>[0])
      const total = responseBytes(download)
      let completed = 0
      const report = () => emitTaskProgress(onTaskProgress, { stage: "tuneweave-download", message: $t("services.tuneweave.service.text_2bc4924588"), completed, total, unit: "bytes" })
      report()
      stream.on("data", (chunk: Buffer) => { hash.update(chunk); completed += chunk.length; report() })
      await pipeline(stream, createWriteStream(file, { mode: 0o700, flags: "wx" }), { signal })
      emitTaskProgress(onTaskProgress, { stage: "tuneweave-verify", message: $t("services.tuneweave.service.text_6acfe6bbb5") })
      if (hash.digest("hex") !== checksum) throw new Error($t("services.tuneweave.service.text_4cd0ffedb7"))
      await fs.chmod(file, 0o700)
      return { file, version: manifest.version }
    } catch (error) { await fs.rm(file, { force: true }); throw error }
  }

  private async requireStoppedRecord() {
    const file = await fs.lstat(path.join(this.root, "process.json")).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error
    })
    if (!file) return
    if (!file.isFile()) throw new Error($t("services.tuneweave.service.text_bcd4997eed"))
    if ((await this.managedProcess()).alive) throw new Error($t("services.tuneweave.service.text_74b5d39fae"))
  }

  private async requireStoppedEndpoint(platform: TuneWeavePlatform, signal?: AbortSignal) {
    const current = await this.status(platform, signal, "error")
    if (current.reachable || current.state !== "stopped") throw new Error($t("services.tuneweave.service.text_2ab520e2e3"))
    await this.requireStoppedRecord()
    signal?.throwIfAborted()
  }

  async startInstalled(expectedVersion: string | undefined, platform: TuneWeavePlatform = "bilibili", signal?: AbortSignal, onTaskProgress?: TaskProgressHandler) {
    signal?.throwIfAborted()
    emitTaskProgress(onTaskProgress, { stage: "tuneweave-start", message: $t("services.tuneweave.service.text_7e52edd093") })
    const url = this.localUrl()
    await this.requireStoppedRecord()
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
    if (pid === undefined) throw new Error($t("services.tuneweave.service.text_0137c4b006"))
    await fs.writeFile(path.join(this.root, "process.json"), JSON.stringify({ pid, api_url: this.config.api_url, identity: await processIdentity(pid, this.platform).catch(() => null) }), { mode: 0o600 })
    try {
      for (let i = 0; i < 30; i++) {
        emitTaskProgress(onTaskProgress, { stage: "tuneweave-health", message: $t("services.tuneweave.service.text_913f9ce906"), completed: i + 1, unit: $t("services.tuneweave.service.text_172fb7e67b") })
        await sleep(1000, undefined, { signal })
        if (child.exitCode !== null || child.signalCode !== null) break
        const ready = await this.status(platform, signal, "error")
        if (ready.ok) {
          if (expectedVersion && compareTuneWeaveVersions(ready.version, expectedVersion) !== 0) throw new Error($t("services.tuneweave.service.text_d64bfbfc55"))
          await sleep(100, undefined, { signal })
          if (child.exitCode !== null || child.signalCode !== null || !await processAlive(pid)) throw new Error($t("services.tuneweave.service.text_e77a980a68"))
          return { ...ready, pid }
        }
        if (ready.reachable) throw new Error(ready.message)
      }
      throw new Error($t("services.tuneweave.service.text_c8a6e55f90"))
    } catch (error) {
      // Only terminate the child created by this start attempt.
      if (await processAlive(pid)) await this.stopManaged(pid)
      throw error
    }
  }

  async managedProcess() {
    this.localUrl()
    let state: ProcessState
    const record = path.join(this.root, "process.json")
    const info = await fs.lstat(record).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error
    })
    if (!info) throw new Error($t("services.tuneweave.service.text_5b6be444bd"))
    if (!info.isFile()) throw new Error($t("services.tuneweave.service.text_bcd4997eed"))
    try { state = JSON.parse(await fs.readFile(record, "utf8")) } catch { throw new Error($t("services.tuneweave.service.text_83ac94b7fc")) }
    if (!state || !Number.isInteger(state.pid) || state.pid <= 0 || typeof state.api_url !== "string" ||
        new URL(state.api_url).href !== new URL(this.config.api_url).href) throw new Error($t("services.tuneweave.service.text_f8ba61d37f"))
    if (!await processAlive(state.pid)) return { ...state, alive: false }
    const actual = await processIdentity(state.pid, this.platform), executable = await fs.realpath(this.executable).catch(error => {
      if (errorCode(error) === "ENOENT" && state.identity?.executable === path.resolve(this.executable)) return state.identity.executable
      throw error
    })
    const samePath = this.platform === "win32" ? actual.executable.toLowerCase() === executable.toLowerCase() : actual.executable === executable
    if (!samePath || state.identity && (state.identity.executable !== actual.executable || state.identity.started !== actual.started)) throw new Error($t("services.tuneweave.service.text_a3bf82b904"))
    return { ...state, identity: actual, alive: true }
  }

  async stopManaged(expectedPid?: number) {
    const state = await this.managedProcess()
    if (expectedPid && state.pid !== expectedPid) throw new Error($t("services.tuneweave.service.text_0cf00cdda6"))
    if (state.alive) {
      process.kill(state.pid, "SIGTERM")
      for (let i = 0; i < 100 && await processAlive(state.pid); i++) await sleep(100)
      if (await processAlive(state.pid)) {
        // Recheck identity before terminating a process that did not shut down.
        await this.managedProcess()
        process.kill(state.pid, "SIGKILL")
        for (let i = 0; i < 50 && await processAlive(state.pid); i++) await sleep(100)
      }
      if (await processAlive(state.pid)) throw new Error($t("services.tuneweave.service.text_c510c7432e"))
    }
    await fs.rm(path.join(this.root, "process.json"), { force: true })
  }

  async updateIfRequired({ notify = async () => {}, onTaskProgress }: { notify?: Notify; onTaskProgress?: TaskProgressHandler } = {}) {
    return this.lifecycle(() => this.updateInstalled({ notify, onTaskProgress }))
  }

  async updateInstalled({ notify, onTaskProgress, status, manifest, repair = false, platform = "bilibili", signal }: UpdateOptions = {}) {
    signal?.throwIfAborted()
    status ||= await this.status(platform, signal, "error")
    if (!status.reachable) return { ...status, skipped: true, reason: status.state === "stopped" ? "not_running" : "status_unknown" }
    const targetVersion = manifest?.version || TUNEWEAVE_REQUIRED_VERSION
    if (!repair && compareTuneWeaveVersions(status.version, targetVersion) >= 0) return { ...status, skipped: true, reason: "up_to_date" }
    const state = await this.managedProcess()
    if (!state.alive) throw new Error($t("services.tuneweave.service.text_16b6c2800f"))
    const send = async (message: string) => {
      emitTaskProgress(onTaskProgress, { stage: "tuneweave-update", message })
      try { await notify?.(message) } catch (error) {
        const logger = (globalThis as typeof globalThis & { logger?: { warn?: (text: string) => void } }).logger
        logger?.warn?.($t("services.tuneweave.service.text_571488b1d8", { "value1": errorMessage(error) }))
      }
    }
    await send($t("services.tuneweave.service.text_a4d7e55d1a", { "version": status.version, "value2": repair ? $t("services.tuneweave.service.text_37a6939250") : $t("services.tuneweave.service.text_d9f89ed513"), "targetVersion": targetVersion }))
    let release: TuneWeaveRelease | undefined, backup: string | null | undefined, replaced = false, stopped = false
    try {
      release = await this.downloadRelease(manifest, signal, onTaskProgress)
      if ((await this.managedProcess()).pid !== state.pid) throw new Error($t("services.tuneweave.service.text_ceaaa87695"))
      signal?.throwIfAborted()
      emitTaskProgress(onTaskProgress, { stage: "tuneweave-restart", message: $t("services.tuneweave.service.text_c220d531d2") })
      try { await this.stopManaged(state.pid); stopped = true }
      catch (error) { stopped = !await processAlive(state.pid); throw error }
      backup = `${this.executable}.previous-${crypto.randomUUID()}`
      try { await fs.rename(this.executable, backup) } catch (error) { if (errorCode(error) === "ENOENT") backup = null; else throw error }
      try { await fs.rename(release.file, this.executable); replaced = true }
      catch (error) { if (backup) await fs.rename(backup, this.executable); backup = null; throw error }
      const ready = await this.startInstalled(release.version, platform, signal, onTaskProgress)
      if (backup) await fs.rm(backup, { force: true }); backup = null
      await send($t("services.tuneweave.service.text_7355b5715c", { "version": status.version, "value2": ready.version }))
      return { ...ready, updated: true, previousVersion: status.version }
    } catch (error) {
      let recovery = $t("services.tuneweave.service.text_52c89611e0")
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
          recovery = $t("services.tuneweave.service.text_858315528a", { "version": status.version })
        } catch (rollbackError) { recovery = $t("services.tuneweave.service.text_dae9264b88", { "value1": errorMessage(rollbackError) }) }
      }
      await send($t("services.tuneweave.service.text_fbcb87f76c", { "value1": errorMessage(error), "recovery": recovery }))
      throw Object.assign(new Error($t("services.tuneweave.service.text_114fdb3a7e", { "value1": errorMessage(error), "recovery": recovery })), { notified: true })
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
      if (status.state !== "stopped") throw new Error(status.message)
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
  if (credentials.length > 8 || credentials.some(value => typeof value !== "string" || !value.startsWith("twc1_") || value.length > 65536 || /[\r\n]/.test(value))) throw new Error($t("services.tuneweave.service.text_50fc93b6b1"))
  const url = new URL(target), transport = url.protocol === "https:" ? https : http
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method, headers: { ...headers, "X-TuneWeave-Credential": [...credentials] }, signal }, response => {
      const chunks: Buffer[] = []; let bytes = 0
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) response.destroy(new Error($t("services.tuneweave.service.text_8b9e04c03a"))); else chunks.push(chunk) })
      response.on("error", reject); response.on("aborted", () => reject(new Error($t("services.tuneweave.service.text_8da21b51d8"))))
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
  if (!artifact || artifact.verification?.algorithm !== "sha256") throw new Error($t("services.tuneweave.service.text_e2d06c47ab", { "platform": platform, "arch": arch }))
  const releasePath = `/MOPELotus/TuneWeave/releases/download/v${manifest.version.replace(/^v/u, "")}/`
  for (const value of [artifact.download_url, artifact.verification.checksum_url]) {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/MOPELotus/TuneWeave/releases/download/")) throw new Error($t("services.tuneweave.service.text_23d3bfee43"))
    if (!url.pathname.startsWith(releasePath)) throw new Error($t("services.tuneweave.service.text_a00b9027bf"))
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
    if (!executable) throw new Error($t("services.tuneweave.service.text_e3b54b6d55"))
    return { executable: await fs.realpath(executable), started }
  }
  if (platform === "darwin") {
    const [file, birth] = await Promise.all([runFile("ps", ["-p", String(pid), "-o", "comm="], { timeout: 15000 }), runFile("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 15000 })])
    return { executable: await fs.realpath(file.stdout.trim()), started: birth.stdout.trim() }
  }
  throw new Error($t("services.tuneweave.service.text_14d2e71660"))
}
