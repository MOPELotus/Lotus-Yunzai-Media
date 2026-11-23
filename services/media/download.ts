import { fetchCdn, type CdnKind, type MediaFetch } from "./cdn.ts"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { discardBody, readStream, writeChunk } from "./transfer.ts"

export type MediaKind = "image" | "video"

interface DownloadOptions {
  readonly fetch?: MediaFetch
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly kind?: MediaKind
  readonly cdn?: Exclude<CdnKind, "image" | "acfun-image" | "weixin-channels-image">
  readonly signal?: AbortSignal
}

export function sniffMedia(bytes: Buffer): { kind: MediaKind; ext: string } | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { kind: "image", ext: ".png" }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { kind: "image", ext: ".jpg" }
  if (/^GIF8[79]a/.test(bytes.toString("ascii", 0, 6))) return { kind: "image", ext: ".gif" }
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { kind: "image", ext: ".webp" }
  if (bytes.toString("ascii", 4, 8) === "ftyp") {
    const brand = bytes.toString("ascii", 8, 12)
    if (["avif", "avis", "heic", "heix", "mif1"].includes(brand)) return { kind: "image", ext: brand.startsWith("avi") ? ".avif" : ".heic" }
    return { kind: "video", ext: ".mp4" }
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return { kind: "video", ext: ".mkv" }
  if (bytes.toString("ascii", 0, 3) === "FLV") return { kind: "video", ext: ".flv" }
  if (bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47) return { kind: "video", ext: ".ts" }
  return null
}

/** No resumptions across mirrors. Failed transfers never become final files. */
export async function downloadMedia(url: string, targetBase: string, { fetch: fetchImpl = globalThis.fetch, headers = {}, timeoutMs = 600000, maxBytes = 0, kind, cdn, signal }: DownloadOptions = {}) {
  const controller = new AbortController()
  const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const temp = `${targetBase}.${randomUUID()}.part`
  let length = 0
  let prefix = Buffer.alloc(0)
  const sniffBytes = cdn === "acfun-video" ? 377 : 64
  try {
    active.throwIfAborted()
    const response = await fetchCdn(fetchImpl, url, { headers: { "Accept-Encoding": "identity", ...headers }, signal: active }, cdn)
    if (response.status !== 200 || !response.body || response.headers.has("content-range")) {
      discardBody(response)
      throw new Error(`媒体下载失败 HTTP ${response.status}`)
    }
    const declared = response.headers.get("content-length")
    const expected = declared === null ? undefined : Number(declared)
    if (expected !== undefined && (!/^\d+$/u.test(declared!) || !Number.isSafeInteger(expected) || expected < 1)) {
      discardBody(response)
      throw new Error("媒体下载不完整")
    }
    if (maxBytes > 0 && expected !== undefined && expected > maxBytes) {
      discardBody(response)
      throw new Error("媒体大小超过下载限制")
    }
    const output = await fs.open(temp, "wx").catch(error => { discardBody(response); throw error })
    try {
      for await (const chunk of readStream(response.body, active)) {
        const next = length + chunk.length
        if (maxBytes > 0 && next > maxBytes) throw new Error("媒体大小超过下载限制")
        if (expected !== undefined && next > expected) throw new Error("媒体下载不完整")
        if (prefix.length < sniffBytes) prefix = Buffer.concat([prefix, chunk.subarray(0, sniffBytes - prefix.length)])
        await writeChunk(output, chunk, length)
        length = next
      }
    } finally {
      await output.close()
    }
    active.throwIfAborted()
    if (length === 0 || expected !== undefined && length !== expected) throw new Error("媒体下载不完整")
    const detected = sniffMedia(prefix)
    if (!detected || kind && detected.kind !== kind) throw new Error("返回内容不是预期媒体，可能为错误页面或无效 CDN 响应")
    const file = `${targetBase}${detected.ext}`
    await fs.rename(temp, file)
    return { file, kind: detected.kind, sizeBytes: length }
  } catch (error) {
    const timedOut = controller.signal.aborted || error instanceof Error && error.name === "AbortError"
    controller.abort()
    throw new Error(signal?.aborted ? "媒体下载已取消" : timedOut ? "媒体下载超时" : error instanceof Error ? error.message : String(error), { cause: error })
  } finally {
    clearTimeout(timer)
    controller.abort()
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}
