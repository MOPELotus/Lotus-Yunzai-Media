import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { emitTaskProgress, responseBytes, type TaskProgressHandler } from "../progress.ts"
import { Readable } from "node:stream"
import type { ReadableStream } from "node:stream/web"
import { pipeline } from "node:stream/promises"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { resolveData, rootPath } from "../../core/path.ts"

const TOOL_NAMES = ["ffmpeg"] as const
const DEFAULT_INSTALL_ATTEMPTS = 3

type ToolName = typeof TOOL_NAMES[number]
type ProgressHandler = (message: string) => unknown

export interface ToolsConfig {
  dir?: string
  bin_dir?: string
  github_api?: string
  timeout_ms?: number | string
  download_retries?: number | string
  ffmpeg?: {
    repo?: string
    command?: string
    asset_patterns?: readonly (string | RegExp)[]
  }
}

interface ProgressOptions {
  signal?: AbortSignal
  onProgress?: ProgressHandler
  onTaskProgress?: TaskProgressHandler
}

interface EnsureOptions extends ProgressOptions {
  config?: ToolsConfig
}

interface InstallerOptions extends EnsureOptions {
  fetch?: typeof fetch
  spawn?: typeof spawn
  platform?: string
  arch?: string
}

interface ProcessOptions {
  onTaskProgress?: TaskProgressHandler
  signal?: AbortSignal
  timeoutMs?: number
  cwd?: string
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
  id?: number
  updated_at?: string
  digest?: string | null
}

type PayloadFingerprint = Record<string, string>

interface InstallReceipt {
  repo?: string
  assetId?: number
  updatedAt?: string
  digest?: string
  files?: PayloadFingerprint
}

type ToolHealth = { ok: true } | { ok: false; reason: string }
type ToolSuccess = {
  name: ToolName
  ok: true
  status: "ready" | "installed"
  path: string
  external?: true
  repo?: string
  asset?: string
  attempts?: number
  updateDeferred?: true
  reason?: string
}
type ToolResult = ToolSuccess | { name: ToolName; ok: false; reason: string }

const toolInstallations = new Map<string, Promise<ToolSuccess>>()

async function awaitExisting(pending: Promise<ToolSuccess>, signal?: AbortSignal) {
  if (!signal) return pending
  signal.throwIfAborted()
  const canceled = Promise.withResolvers<never>()
  const onAbort = () => canceled.reject(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })
  try { return await Promise.race([pending, canceled.promise]) }
  finally { signal.removeEventListener("abort", onAbort) }
}

function deadline(timeoutMs: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export class ToolInstallerService {
  readonly config?: ToolsConfig
  readonly fetch: typeof fetch
  readonly spawn: typeof spawn
  readonly platform: string
  readonly arch: string
  readonly onTaskProgress?: TaskProgressHandler
  readonly onProgress?: ProgressHandler

  constructor(options: InstallerOptions = {}) {
    this.config = options.config
    this.fetch = options.fetch || globalThis.fetch
    this.spawn = options.spawn || spawn
    this.platform = options.platform || process.platform
    this.arch = options.arch || process.arch
    this.onTaskProgress = options.onTaskProgress
    this.onProgress = options.onProgress
  }

  async getConfig(): Promise<ToolsConfig> {
    if (this.config) return this.config
    const globalConfig = await loadGlobalConfig()
    return globalConfig.tools || {}
  }

  /** Read-only startup check: no release lookup, installation or update. */
  async checkAll(options: EnsureOptions = {}) {
    const config = normalizeToolsConfig(options.config || await this.getConfig())
    const binDir = resolveMaybeData(config.bin_dir), toolsDir = resolveMaybeData(config.dir)
    const items: ToolResult[] = []
    for (const name of TOOL_NAMES) {
      options.signal?.throwIfAborted()
      try {
        const executable = await findCommandExecutable(config[name].command, [binDir], this.platform)
        const probe = await findCommandExecutable("ffprobe", [binDir], this.platform)
        if (!executable || !probe) throw new Error("媒体工具尚未初始化，请运行 bun run bootstrap")
        const real = await fs.realpath(executable)
        if (path.dirname(real) === path.resolve(binDir)) {
          const health = await inspectToolInstall(name, executable, binDir, toolsDir, this.platform)
          if (!health.ok) throw new Error(health.reason)
        }
        await runSpawn(this.spawn, executable, ["-version"], { timeoutMs: 15000, signal: options.signal })
        await runSpawn(this.spawn, probe, ["-version"], { timeoutMs: 15000, signal: options.signal })
        items.push({ name, ok: true, status: "ready", path: executable, ...(path.dirname(real) !== path.resolve(binDir) && { external: true as const }) })
      } catch (error) {
        options.signal?.throwIfAborted()
        items.push({ name, ok: false, reason: errorMessage(error) })
      }
    }
    return { ok: items.every(item => item.ok), skipped: false, binDir, items }
  }

  async ensureAll(options: EnsureOptions = {}) {
    const { signal } = options
    signal?.throwIfAborted()
    const onTaskProgress = options.onTaskProgress || this.onTaskProgress
    const onProgress: ProgressHandler = message => {
      emitTaskProgress(onTaskProgress, { stage: "ffmpeg", message })
      return (options.onProgress || this.onProgress)?.(message)
    }
    const config = normalizeToolsConfig(options.config || await this.getConfig())

    const items: ToolResult[] = []
    for (const name of TOOL_NAMES) {
      await emitProgress(onProgress, `工具链：检查 ${name}`)
      items.push(await this.ensureTool(name, config, { onProgress: options.onProgress || this.onProgress, onTaskProgress, signal }).catch(async (error: unknown): Promise<ToolResult> => {
        signal?.throwIfAborted()
        const reason = errorMessage(error)
        await emitProgress(onProgress, `工具链：${name} 失败：${reason}`)
        return {
          name,
          ok: false,
          reason,
        }
      }))
    }

    return {
      ok: items.every(item => item.ok),
      skipped: false,
      binDir: resolveMaybeData(config.bin_dir || "data/tools/bin"),
      items,
    }
  }

  async ensureTool(name: string, config: ToolsConfig | null = null, options: ProgressOptions = {}) {
    if (name !== "ffmpeg") throw new Error(`unknown tool: ${name}`)
    options.signal?.throwIfAborted()
    const normalized = normalizeToolsConfig(config || await this.getConfig())
    const key = `${resolveMaybeData(normalized.dir)}:${resolveMaybeData(normalized.bin_dir)}:${name}`
    const active = toolInstallations.get(key)
    if (active) return awaitExisting(active, options.signal)
    const pending = this.installTool(name, normalized, options)
    toolInstallations.set(key, pending)
    try { return await pending } finally { toolInstallations.delete(key) }
  }

  async installTool(name: ToolName, normalized: ReturnType<typeof normalizeToolsConfig>, options: ProgressOptions = {}): Promise<ToolSuccess> {
    const { signal } = options
    signal?.throwIfAborted()
    const onTaskProgress = options.onTaskProgress || this.onTaskProgress
    const onProgress: ProgressHandler = message => {
      emitTaskProgress(onTaskProgress, { stage: "ffmpeg", message })
      return (options.onProgress || this.onProgress)?.(message)
    }
    const tool = normalized[name]
    if (!tool) throw new Error(`unknown tool: ${name}`)

    const binDir = resolveMaybeData(normalized.bin_dir || "data/tools/bin")
    const toolsDir = resolveMaybeData(normalized.dir || "data/tools")
    const existing = await findCommandExecutable(tool.command, [binDir], this.platform)
    let health: ToolHealth | undefined
    if (existing) {
      const real = await fs.realpath(existing)
      if (path.dirname(real) !== path.resolve(binDir)) {
        const probe = await findCommandExecutable("ffprobe", [binDir], this.platform)
        if (!probe) throw new Error("外部 FFmpeg 缺少 ffprobe，请由部署者修复")
        try {
          await runSpawn(this.spawn, existing, ["-version"], { timeoutMs: 15000, signal })
          await runSpawn(this.spawn, probe, ["-version"], { timeoutMs: 15000, signal })
        } catch { signal?.throwIfAborted(); throw new Error("外部 FFmpeg 环境异常，请由部署者修复") }
        return { name, ok: true, status: "ready", path: existing, external: true }
      }
      health = await inspectToolInstall(name, existing, binDir, toolsDir, this.platform)
      if (health.ok) {
        await ensureExecutablePermissions(name, existing, binDir, this.platform)
        try { await runSpawn(this.spawn, existing, ["-version"], { timeoutMs: 15000, signal }); await runSpawn(this.spawn, path.join(binDir, commandFileName("ffprobe", this.platform)), ["-version"], { timeoutMs: 15000, signal }) }
        catch { signal?.throwIfAborted(); health = { ok: false, reason: "工具无法正常执行" } }
      }
      if (!health.ok) await emitProgress(onProgress, `工具链：${name} 需要修复：${health.reason}`)
    }

    const receiptFile = path.join(toolsDir, `${name}-install.json`)
    let receipt: InstallReceipt | undefined
    let receiptInvalid = false
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(receiptFile, "utf8"))
      receipt = readReceipt(parsed)
      receiptInvalid = Boolean(parsed) && !receipt
    } catch (error) {
      if (error instanceof SyntaxError) receiptInvalid = true
      else if (!isMissingFile(error)) throw error
    }
    const localFiles = health?.ok ? await fingerprintPayload(binDir, this.platform, signal, onTaskProgress) : null
    const localVerified = health?.ok && !receiptInvalid && (!receipt || receipt.repo === tool.repo && JSON.stringify(localFiles) === JSON.stringify(receipt.files))
    try {
      signal?.throwIfAborted()
      if (typeof this.fetch !== "function") throw new Error("fetch is unavailable")
      if (name === "ffmpeg") await removeSharedFfmpegArtifacts(toolsDir)
      await emitProgress(onProgress, `工具链：查询 ${tool.repo} 最新版本`)
      const release = await this.fetchLatestRelease(tool.repo, normalized.github_api, null, signal)
      const asset = pickReleaseAsset(name, release.assets, {
        platform: this.platform,
        arch: this.arch,
        patterns: tool.asset_patterns,
      })
      if (!asset) throw new Error(`no release asset matched ${name} ${this.platform}/${this.arch}`)
      if (health?.ok && receipt?.repo === tool.repo && receipt.assetId === asset.id && receipt.updatedAt === asset.updated_at && receipt.digest === asset.digest) {
        const files = await fingerprintPayload(binDir, this.platform, signal, onTaskProgress)
        if (JSON.stringify(files) === JSON.stringify(receipt.files)) return { name, ok: true, status: "ready", path: existing, asset: asset.name }
      }

      const archiveDir = path.join(toolsDir, "downloads")
      const extractDir = path.join(toolsDir, name)
      await fs.mkdir(archiveDir, { recursive: true })
      await fs.mkdir(binDir, { recursive: true })

      const archive = path.join(archiveDir, safeFileName(asset.name))
      const attempts = Math.max(1, Number(normalized.download_retries || DEFAULT_INSTALL_ATTEMPTS))
      let lastError: unknown
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        signal?.throwIfAborted()
        try {
          await fs.rm(extractDir, { recursive: true, force: true })
          await fs.mkdir(extractDir, { recursive: true })
          await fs.rm(archive, { force: true }).catch(() => null)

          await emitProgress(onProgress, `工具链：下载 ${asset.name}${attempt > 1 ? `（重试 ${attempt}/${attempts}）` : ""}`)
          await this.downloadAsset(asset.browser_download_url, archive, { timeoutMs: normalized.timeout_ms, signal, onTaskProgress })
          if (!asset.digest || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) throw new Error("发布包缺少 SHA-256，保留原工具")
          if (await sha256File(archive, signal, onTaskProgress) !== asset.digest.slice(7).toLowerCase()) throw new Error("FFmpeg 发布包 SHA-256 不匹配")
          await emitProgress(onProgress, `工具链：准备 ${asset.name}`)
          emitTaskProgress(onTaskProgress, { stage: "ffmpeg-extract", message: "正在解包 FFmpeg" })
          await extractArchive(this.spawn, archive, extractDir, { timeoutMs: normalized.timeout_ms, signal })

          const executable = await findExtractedExecutable(extractDir, tool.command, this.platform)
          if (!executable) throw new Error(`${tool.command} executable not found in ${asset.name}`)
          await runSpawn(this.spawn, executable, ["-version"], { timeoutMs: 15000, signal })
          await runSpawn(this.spawn, path.join(path.dirname(executable), commandFileName("ffprobe", this.platform)), ["-version"], { timeoutMs: 15000, signal })

          // Finish publishing the checked pair and receipt as one operation once replacement starts.
          signal?.throwIfAborted()
          emitTaskProgress(onTaskProgress, { stage: "ffmpeg-install", message: "正在安装并校验 FFmpeg 与 ffprobe" })
          const target = await copyToolPayload(name, executable, binDir, tool.command, this.platform)
          const receiptTemp = `${receiptFile}.${randomUUID()}.tmp`
          try {
            await fs.writeFile(receiptTemp, JSON.stringify({ repo: tool.repo, assetId: asset.id, updatedAt: asset.updated_at, digest: asset.digest, files: await fingerprintPayload(binDir, this.platform, undefined, onTaskProgress) }), { flag: "wx" })
            await fs.rename(receiptTemp, receiptFile)
          } finally { await fs.rm(receiptTemp, { force: true }) }
          await emitProgress(onProgress, `工具链：${name} 安装完成`)

          return {
            name,
            ok: true,
            status: "installed",
            repo: tool.repo,
            asset: asset.name,
            path: target,
            attempts: attempt,
          }
        } catch (error) {
          lastError = error
          await cleanupBrokenInstallArtifacts(archive, extractDir)
          signal?.throwIfAborted()
          if (attempt < attempts) {
            await emitProgress(onProgress, `工具链：${name} 安装包异常，已清理并准备重下：${errorMessage(error)}`)
          }
        }
      }
      throw new Error(`${lastError ? errorMessage(lastError) : `${tool.command} install failed`}；已自动重试 ${attempts} 次`)
    } catch (error) {
      signal?.throwIfAborted()
      // Only retain the exact healthy payload checked before attempting update.
      // Missing files, receipt mismatches and a failed rollback remain errors.
      if (localVerified && JSON.stringify(await fingerprintPayload(binDir, this.platform, undefined, onTaskProgress)) === JSON.stringify(localFiles)) {
        return { name, ok: true, status: "ready", path: existing, updateDeferred: true, reason: "现有 FFmpeg 已通过执行与文件检查，更新暂未完成，稍后重试。" }
      }
      throw error
    }
  }

  async fetchLatestRelease(repo: string, api = "https://api.github.com", tag: string | null = null, signal?: AbortSignal) {
    const base = String(api || "https://api.github.com").replace(/\/+$/, "")
    const response = await this.fetch(`${base}/repos/${repo}/releases/${tag ? `tags/${encodeURIComponent(tag)}` : "latest"}`, {
      signal: deadline(30000, signal),
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Lotus-Yunzai",
      },
    })
    if (!response.ok) throw new Error(`GitHub release request failed: HTTP ${response.status}`)
    const release: unknown = await response.json()
    const assets: unknown[] = isRecord(release) && Array.isArray(release.assets) ? release.assets : []
    return { assets: assets.filter(isReleaseAsset) }
  }

  async downloadAsset(url: string, target: string, { timeoutMs = 300000, signal, onTaskProgress }: ProcessOptions = {}) {
    signal?.throwIfAborted()
    const temp = `${target}.part-${process.pid}-${Date.now()}`
    const response = await this.fetch(url, {
      signal: deadline(timeoutMs, signal),
      headers: {
        "User-Agent": "Lotus-Yunzai",
      },
    })
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
    const total = responseBytes(response)
    let completed = 0
    const report = () => emitTaskProgress(onTaskProgress, { stage: "ffmpeg-download", message: "正在下载 FFmpeg", completed, total, unit: "bytes" })
    report()
    await fs.mkdir(path.dirname(target), { recursive: true })
    try {
      if (response.body && typeof response.body.getReader === "function") {
        // Bun and Node declare the same web stream with different convenience methods.
        const source = Readable.fromWeb(response.body as unknown as ReadableStream<Uint8Array>)
        source.on("data", (chunk: Buffer) => { completed += chunk.length; report() })
        await pipeline(source, fsSync.createWriteStream(temp), { signal })
      } else {
        const bytes = Buffer.from(await response.arrayBuffer())
        await fs.writeFile(temp, bytes)
        completed = bytes.length
        report()
      }
      signal?.throwIfAborted()
      await fs.rm(target, { force: true }).catch(() => null)
      await fs.rename(temp, target)
      return target
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => null)
      throw error
    }
  }
}

export function normalizeToolsConfig(config: ToolsConfig = {}) {
  return {
    dir: config.dir || "data/tools",
    bin_dir: config.bin_dir || "data/tools/bin",
    github_api: config.github_api || "https://api.github.com",
    timeout_ms: Number(config.timeout_ms || 300000),
    download_retries: Math.max(1, Number(config.download_retries || DEFAULT_INSTALL_ATTEMPTS)),
    ffmpeg: {
      repo: config.ffmpeg?.repo || "BtbN/FFmpeg-Builds",
      command: config.ffmpeg?.command || "ffmpeg",
      asset_patterns: config.ffmpeg?.asset_patterns,
    },
  }
}

export function pickReleaseAsset(tool: string, assets: readonly ReleaseAsset[] = [], options: { platform?: string; arch?: string; patterns?: readonly (RegExp | string)[] } = {}) {
  const patterns = (options.patterns || defaultAssetPatterns(tool, options.platform, options.arch))
    .map(pattern => pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i"))
  const candidates = assets
    .filter(asset => asset?.name && asset?.browser_download_url && !isDisallowedReleaseAsset(tool, asset.name))
    .map(asset => ({
      asset,
      score: scoreReleaseAsset(asset.name, patterns),
    }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.asset.name.localeCompare(b.asset.name))
  return candidates[0]?.asset || null
}

export function defaultAssetPatterns(tool: string, platform: string = process.platform, arch: string = process.arch) {
  const os = normalizePlatform(platform)
  const cpu = normalizeArch(arch)
  if (tool === "ffmpeg") {
    if (os === "windows") return [/ffmpeg(?!.*shared).*win64.*gpl.*\.zip$/i, /ffmpeg(?!.*shared).*windows.*64.*\.zip$/i]
    if (os === "linux") {
      return cpu === "arm64"
        ? [/ffmpeg(?!.*shared).*linuxarm64.*gpl.*\.tar\.xz$/i, /ffmpeg(?!.*shared).*linux.*arm64.*\.tar\.xz$/i]
        : [/ffmpeg(?!.*shared).*linux64.*gpl.*\.tar\.xz$/i, /ffmpeg(?!.*shared).*linux.*(?:x64|amd64).*\.tar\.xz$/i]
    }
    if (os === "darwin") return [/ffmpeg(?!.*shared).*macos64.*gpl.*\.zip$/i, /ffmpeg(?!.*shared).*(?:mac|darwin).*\.zip$/i]
  }
  return [/\.zip$/i, /\.tar\.(?:gz|xz)$/i]
}

export function scoreReleaseAsset(name: string, patterns: readonly RegExp[] = []) {
  for (let index = 0; index < patterns.length; index += 1) {
    if (patterns[index]?.test(name)) return patterns.length - index
  }
  return -1
}

export function isDisallowedReleaseAsset(tool: string, name = "") {
  return tool === "ffmpeg" && /(?:^|[-_.])shared(?:[-_.]|$)/i.test(String(name || ""))
}

export async function findCommandExecutable(command: string, dirs: readonly string[] = [], platform: string = process.platform) {
  const fileName = commandFileName(command, platform)
  for (const dir of dirs.filter(Boolean)) {
    const candidate = path.join(resolveMaybeData(dir), fileName)
    if (await exists(candidate)) return candidate
  }
  return ""
}

export function normalizePlatform(platform: string = process.platform) {
  if (platform === "win32") return "windows"
  if (platform === "darwin") return "darwin"
  return "linux"
}

export function normalizeArch(arch: string = process.arch) {
  if (["x64", "amd64", "x86_64"].includes(arch)) return "x64"
  if (["arm64", "aarch64"].includes(arch)) return "arm64"
  return arch
}

async function extractArchive(spawnImpl: typeof spawn, archive: string, target: string, options: ProcessOptions = {}) {
  const lower = archive.toLowerCase()
  const command = lower.endsWith(".zip") ? process.platform === "win32" ? "powershell.exe" : "unzip"
    : /\.(tar\.gz|tgz|tar\.xz|txz)$/i.test(lower) ? "tar" : undefined
  if (command && !Bun.which(command)) throw new Error(`无法解包媒体工具：缺少 ${command}，请安装该工具后重新运行 bun run bootstrap。`)
  if (lower.endsWith(".zip")) {
    if (process.platform === "win32") {
      const command = `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${target.replace(/'/g, "''")}' -Force`
      await runSpawn(spawnImpl, "powershell.exe", ["-NoProfile", "-Command", command], options)
      return
    }
    await runSpawn(spawnImpl, "unzip", ["-o", archive, "-d", target], options)
    return
  }
  if (/\.(tar\.gz|tgz|tar\.xz|txz)$/i.test(lower)) {
    await runSpawn(spawnImpl, "tar", ["-xf", archive, "-C", target], options)
    return
  }
  throw new Error(`unsupported archive: ${path.basename(archive)}`)
}

async function findExtractedExecutable(root: string, command: string, platform: string = process.platform) {
  const wanted = commandFileName(command, platform).toLowerCase()
  const fallback = String(command || "").toLowerCase()
  const queue = [root]
  for (const dir of queue) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase()
        if (lower === wanted || lower === fallback) return full
      }
    }
  }
  return ""
}

function runSpawn(spawnImpl: typeof spawn, command: string, args: string[] = [], options: ProcessOptions = {}) {
  const { signal } = options
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd || rootPath,
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, Number(options.timeoutMs || 300000))

    const onAbort = () => { child.kill("SIGKILL") }
    signal?.addEventListener("abort", onAbort, { once: true })
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort) }
    child.stdout?.on("data", chunk => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString()
    })
    child.on("error", error => { cleanup(); reject(error) })
    child.on("close", code => {
      cleanup()
      if (signal?.aborted) { reject(signal.reason); return }
      if (code === 0 && !timedOut) {
        resolve({ ok: true, code, stdout, stderr })
        return
      }
      const error = new Error(timedOut ? `${command} timed out` : stderr || stdout || `${command} exited with code ${code}`)
      reject(Object.assign(error, { code, timedOut, stdout, stderr }))
    })
  })
}

export function commandFileName(command: string, platform: string = process.platform) {
  if (platform === "win32" && !/\.exe$/i.test(command)) return `${command}.exe`
  return command
}

function resolveMaybeData(value = "") {
  const text = String(value || "")
  if (!text) return ""
  if (path.isAbsolute(text)) return text
  if (text.startsWith("data/") || text.startsWith("data\\")) return resolveData(text.slice(5))
  return path.resolve(rootPath, text)
}

async function inspectToolInstall(name: ToolName, executable: string, binDir: string, toolsDir: string, platform: string = process.platform): Promise<ToolHealth> {
  if (name !== "ffmpeg") return { ok: true }
  if (await hasSharedFfmpegMarker(toolsDir)) {
    return {
      ok: false,
      reason: "检测到旧 ffmpeg shared 下载包",
    }
  }
  const ffprobe = path.join(binDir, commandFileName("ffprobe", platform))
  if (!await exists(ffprobe)) {
    return {
      ok: false,
      reason: "缺少 ffprobe",
    }
  }
  if (!await exists(executable)) {
    return {
      ok: false,
      reason: "缺少 ffmpeg",
    }
  }
  return { ok: true }
}

async function copyToolPayload(name: ToolName, executable: string, binDir: string, command: string, platform: string = process.platform) {
  const target = path.join(binDir, commandFileName(command, platform))
  if (name !== "ffmpeg") {
    // rename 替换软链接本身，避免覆盖插件目录外的链接目标；旧版本在下载失败时仍可用。
    const staging = `${target}.install-${process.pid}`
    try {
      await fs.copyFile(executable, staging)
      if (platform !== "win32") await fs.chmod(staging, 0o755)
      await fs.rename(staging, target)
    } finally { await fs.rm(staging, { force: true }).catch(() => null) }
    return target
  }

  const sourceDir = path.dirname(executable)
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })
  const staging = await fs.mkdtemp(path.join(binDir, ".ffmpeg-install-"))
  const replaced: { dest: string; backup: string; existed: boolean }[] = []
  try {
    for (const entry of entries) {
      if (!entry.isFile() || !shouldCopyFfmpegPayloadFile(entry.name, platform)) continue
      const next = path.join(staging, entry.name), dest = path.join(binDir, entry.name), backup = `${next}.previous`
      await fs.copyFile(path.join(sourceDir, entry.name), next)
      if (platform !== "win32") await fs.chmod(next, 0o755)
      let existed = true
      try { await fs.rename(dest, backup) } catch (error) { if (isMissingFile(error)) existed = false; else throw error }
      replaced.push({ dest, backup, existed })
      await fs.rename(next, dest)
    }
  } catch (error) {
    for (const item of replaced.reverse()) {
      await fs.rm(item.dest, { force: true })
      if (item.existed) await fs.rename(item.backup, item.dest)
    }
    throw error
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
  return target
}

async function sha256File(file: string, signal?: AbortSignal, onTaskProgress?: TaskProgressHandler) {
  const hash = createHash("sha256"), total = (await fs.stat(file)).size
  let completed = 0
  const report = () => emitTaskProgress(onTaskProgress, { stage: "ffmpeg-verify", message: `正在校验 ${path.basename(file)}`, completed, total, unit: "bytes" })
  report()
  for await (const chunk of fsSync.createReadStream(file, { signal })) { hash.update(chunk); completed += chunk.length; report() }
  return hash.digest("hex")
}

async function fingerprintPayload(binDir: string, platform: string, signal?: AbortSignal, onTaskProgress?: TaskProgressHandler): Promise<PayloadFingerprint> {
  const entries = (await fs.readdir(binDir, { withFileTypes: true })).filter(entry => entry.isFile() && shouldCopyFfmpegPayloadFile(entry.name, platform)).sort((a, b) => a.name.localeCompare(b.name))
  return Object.fromEntries(await Promise.all(entries.map(async entry => [entry.name, await sha256File(path.join(binDir, entry.name), signal, onTaskProgress)])))
}

async function ensureExecutablePermissions(name: ToolName, executable: string, binDir: string, platform: string = process.platform) {
  if (platform === "win32") return
  await fs.chmod(executable, 0o755).catch(() => null)
  if (name !== "ffmpeg") return
  for (const command of ["ffmpeg", "ffprobe", "ffplay"]) {
    await fs.chmod(path.join(binDir, commandFileName(command, platform)), 0o755).catch(() => null)
  }
}

async function cleanupBrokenInstallArtifacts(archive: string, extractDir: string) {
  await fs.rm(archive, { force: true }).catch(() => null)
  await fs.rm(extractDir, { recursive: true, force: true }).catch(() => null)
  const archiveDir = path.dirname(archive)
  const archiveName = path.basename(archive)
  const entries = await fs.readdir(archiveDir).catch(error => {
    if (isMissingFile(error)) return []
    throw error
  })
  await Promise.all(entries
    .filter(name => name.startsWith(`${archiveName}.part-`))
    .map(name => fs.rm(path.join(archiveDir, name), { force: true })))
}

function shouldCopyFfmpegPayloadFile(name: string, platform: string = process.platform) {
  const lower = String(name || "").toLowerCase()
  if (platform === "win32") {
    return lower.endsWith(".exe") || lower.endsWith(".dll")
  }
  return ["ffmpeg", "ffprobe", "ffplay"].includes(lower)
    || lower.endsWith(".so")
    || lower.includes(".so.")
    || lower.endsWith(".dylib")
}

async function hasSharedFfmpegMarker(toolsDir: string) {
  const archiveDir = path.join(toolsDir, "downloads")
  const entries = await fs.readdir(archiveDir).catch(error => {
    if (isMissingFile(error)) return []
    throw error
  })
  return entries.some(name => /ffmpeg.*shared/i.test(name))
}

async function removeSharedFfmpegArtifacts(toolsDir: string) {
  const archiveDir = path.join(toolsDir, "downloads")
  const entries = await fs.readdir(archiveDir).catch(error => {
    if (isMissingFile(error)) return []
    throw error
  })
  await Promise.all(entries
    .filter(name => /ffmpeg.*shared/i.test(name))
    .map(name => fs.rm(path.join(archiveDir, name), { recursive: true, force: true })))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isReleaseAsset(value: unknown): value is ReleaseAsset {
  return isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.browser_download_url === "string" &&
    (value.id === undefined || typeof value.id === "number") &&
    (value.updated_at === undefined || typeof value.updated_at === "string") &&
    (value.digest === undefined || value.digest === null || typeof value.digest === "string")
}

function isPayloadFingerprint(value: unknown): value is PayloadFingerprint {
  return isRecord(value) && Object.values(value).every(hash => typeof hash === "string")
}

function readReceipt(value: unknown): InstallReceipt | undefined {
  if (!isRecord(value)) return
  const { repo, assetId, updatedAt, digest, files } = value
  return {
    repo: typeof repo === "string" ? repo : undefined,
    assetId: typeof assetId === "number" ? assetId : undefined,
    updatedAt: typeof updatedAt === "string" ? updatedAt : undefined,
    digest: typeof digest === "string" ? digest : undefined,
    files: isPayloadFingerprint(files) ? files : undefined,
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeFileName(value = "asset") {
  return String(value || "asset").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
}

async function exists(file: string) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function emitProgress(onProgress: ProgressHandler | undefined, message: string) {
  if (typeof onProgress !== "function") return
  try {
    await onProgress(message)
  } catch (error) {
    const host = globalThis as typeof globalThis & { logger?: { debug?: (message: string) => void } }
    host.logger?.debug?.(`[media] progress callback failed: ${errorMessage(error)}`)
  }
}
