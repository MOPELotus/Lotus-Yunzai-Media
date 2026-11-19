import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"

export function safeMediaName(value = "media") {
  let cleaned = String(value).toWellFormed().normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`
  let output = ""
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(cleaned)) {
    if (Buffer.byteLength(output + segment, "utf8") > 180) break
    output += segment
  }
  output = output.replace(/[ .]+$/g, "")
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(output)) output = `_${output}`
  return output || "media"
}

const mediaUploadQueues = new Map()
export const mediaDeliveryUnknown = "MEDIA_DELIVERY_UNKNOWN"

function deliveryUnknown(message) {
  return Object.assign(new Error(message), { code: mediaDeliveryUnknown })
}

export async function sendMediaFile(e, file, config = {}) {
  // QQ maps equal file contents to the same internal cache even when the
  // download directories and NapCat temporary filenames are distinct.
  const hash = createHash("md5")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  const botId = e.self_id ?? e.bot?.self_id ?? e.bot?.uin ?? "unknown-bot"
  const key = `${String(botId)}:${hash.digest("hex")}`
  const previous = mediaUploadQueues.get(key)
  let release
  const current = new Promise(resolve => { release = resolve })
  mediaUploadQueues.set(key, current)
  try {
    if (previous) await previous
    return await sendIsolatedMediaFile(e, file, config)
  } finally {
    release()
    if (mediaUploadQueues.get(key) === current) mediaUploadQueues.delete(key)
  }
}

async function sendIsolatedMediaFile(e, file, config = {}) {
  file = path.resolve(file)
  const stat = await fs.stat(file)
  const ext = path.extname(file).toLowerCase()
  const name = config.file_name || path.basename(file)
  const image = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)
  const video = [".mp4", ".mkv", ".flv", ".mov", ".m4v"].includes(ext) &&
    stat.size <= Number(config.video_size_limit_mb || 100) * 1024 * 1024
  const type = image ? "image" : video ? "video" : "file"
  if (e.deliverMedia) {
    const result = await e.deliverMedia({ path: file, name, type })
    if (result === "confirmed") return true
    if (result === "unknown") throw deliveryUnknown("媒体发送结果未确认，请在会话中核对。")
  }

  // The byte transport remains available for hosts without file-backed delivery.
  if (stat.size > 16 * 1024 * 1024) throw new Error("当前会话无法发送此大小的媒体文件。")
  const bytes = await fs.readFile(file)
  if (type === "file" && e.uploadFile) {
    const result = await e.uploadFile({ name, bytes })
    if (result === "confirmed") return true
    if (result === "unknown") throw deliveryUnknown("文件发送结果未确认，请在会话中核对。")
  } else if (type !== "file" && await e.reply({ type, data: { file: bytes, name } })) {
    return true
  }
  throw new Error("当前会话发送媒体失败。")
}

export async function runMediaProcess(command, args, { cwd, env, timeoutMs = 600000, spawnImpl = spawn, signal } = {}) {
  if (signal?.aborted) throw new Error("媒体处理已取消")
  const owned = cwd && await fs.access(path.join(cwd, ".lotus-media-task.json")).then(() => true, () => false)
  const marker = owned ? path.join(cwd, ".lotus-media-process.json") : null
  if (marker) await fs.writeFile(marker, JSON.stringify({ state: "starting" }))
  let child
  const grouped = process.platform !== "win32"
  const kill = signal => {
    if (!child) return
    try {
      if (grouped && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch { child.kill(signal) }
  }
  const completion = new Promise((resolve, reject) => {
    child = spawnImpl(command, args, { cwd, env, windowsHide: true, detached: grouped })
    let output = ""
    let timedOut = false
    let aborted = false
    let killTimer
    const timer = setTimeout(() => {
      timedOut = true
      kill("SIGTERM")
      killTimer = setTimeout(() => kill("SIGKILL"), 2000)
    }, timeoutMs)
    const onAbort = () => { aborted = true; kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 2000) }
    signal?.addEventListener("abort", onAbort, { once: true })
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", onAbort) }
    const collect = chunk => { output = (output + chunk.toString()).slice(-16000) }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    child.on("error", error => { cleanup(); reject(error) })
    child.on("close", code => {
      cleanup()
      if (!aborted && !timedOut && code !== 0 && /No space left on device|ENOSPC|Disk quota exceeded/i.test(output)) {
        const error = new Error("服务器磁盘空间不足，媒体处理失败。请联系机器人主人清理空间后重试。")
        error.code = "ENOSPC"
        reject(error)
      } else if (aborted || timedOut || code !== 0) reject(new Error(aborted ? "媒体处理已取消" : timedOut ? `${command} 执行超时` : `${command} 执行失败：${output}`))
      else resolve({ code, output })
    })
  })
  completion.catch(() => {}) // Registration may still be awaiting disk when spawn fails.
  try {
    if (marker && child?.pid) await fs.writeFile(marker, JSON.stringify({ state: "running", pid: child.pid }))
    return await completion
  } catch (error) {
    kill("SIGKILL")
    await completion.catch(() => {})
    throw error
  } finally {
    if (marker) await fs.rm(marker, { force: true })
  }
}

export async function packMediaFiles(files, target, options = {}) {
  if (process.platform === "win32") {
    const quote = value => `'${value.replace(/'/g, "''")}'`
    await runMediaProcess("powershell.exe", ["-NoProfile", "-Command",
      `Compress-Archive -LiteralPath ${files.map(quote).join(",")} -DestinationPath ${quote(target)}`], options)
  } else {
    await runMediaProcess("zip", ["-j", target, ...files], options)
  }
  return target
}

export function mediaLimitFailure(info, config) {
  if (config.duration_limit_seconds > 0 && info.duration > config.duration_limit_seconds) {
    return { ok: false, reason: "duration_limit", info, limitSeconds: config.duration_limit_seconds }
  }
  return null
}

export function mediaFailureMessage(result = {}) {
  if (result.reason === "duration_limit") return `视频时长超过 ${Math.round(result.limitSeconds / 60)} 分钟限制。`
  if (result.reason === "estimated_size_limit") return `视频预估大小 ${result.estimatedSizeMb} MB 超过 ${result.limitMb} MB 限制。`
  return result.reason || "下载失败"
}
