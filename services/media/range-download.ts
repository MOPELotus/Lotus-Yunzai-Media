import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import fs from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { withoutReadRetries, withReadRetries } from "@lotus-yunzai/http"
import { retryStreamRead } from "./stream-retry.ts"

import type { MediaFetch } from "./cdn.ts"
import { discardBody, readStream, writeChunk } from "./transfer.ts"

interface RangeOptions {
  readonly fetch?: MediaFetch
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly concurrency?: number
  readonly signal?: AbortSignal
}

function resourceValidators(headers: Headers) {
  return { etag: headers.get("etag"), modified: headers.get("last-modified") }
}

function changesResource(headers: Headers, previous: ReturnType<typeof resourceValidators> | undefined) {
  if (!previous) return false
  const { etag, modified } = resourceValidators(headers)
  if (previous.etag && etag) {
    if (etag !== previous.etag) return true
    if (!etag.startsWith("W/")) return false
  }
  return !!previous.modified && !!modified && modified !== previous.modified
}

// A mirror is always restarted from byte zero; ranges from different CDN objects
// never share a destination. No files are published before complete validation.
export async function downloadRanges(urls: string | readonly (string | undefined)[] | undefined, target: string, options: RangeOptions = {}) {
  const { fetch: fetchImpl = globalThis.fetch, headers = {}, timeoutMs = 600000, maxBytes = 0, concurrency = 4, signal } = options
  const request: MediaFetch = (url, init) => withoutReadRetries(() => fetchImpl(url, init))
  const probeRequest = withReadRetries((url, init) => request(url.href, {
    headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal ?? undefined,
  }))
  const timeout = AbortSignal.timeout(timeoutMs), parentSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let lastError
  for (const url of new Set((typeof urls === "string" ? [urls] : urls ?? []).filter((item): item is string => Boolean(item)))) {
    if (parentSignal.aborted) throw new Error($t("services.media.range-download.text_5ccee370f8"))
    const temp = `${target}.${randomUUID()}.part`, controller = new AbortController(), transferSignal = AbortSignal.any([parentSignal, controller.signal])
    let handle: FileHandle | undefined
    const full = async (initial: Response | (() => Promise<Response>), probedLength?: number, validators?: ReturnType<typeof resourceValidators>) => {
      let first = typeof initial === "function" ? undefined : initial
      return retryStreamRead(async checkResponse => {
        try {
          const response = first ?? await (typeof initial === "function" ? initial() : request(url, { headers: { "Accept-Encoding": "identity", ...headers }, signal: transferSignal }))
          first = undefined
          checkResponse(response)
          if (response.status !== 200 || !response.body || response.headers.has("content-range")) {
            discardBody(response)
            throw new Error($t("services.media.range-download.text_268c53c7dc", { "status": response.status }))
          }
          const contentLength = response.headers.get("content-length")
          const declared = contentLength === null ? undefined : Number(contentLength)
          if (changesResource(response.headers, validators)) {
            discardBody(response)
            throw new Error($t("services.media.range-download.text_591ae276a0"))
          }
          if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 1 ||
              (probedLength !== undefined && probedLength !== declared))) {
            discardBody(response)
            throw new Error($t("services.media.range-download.text_9e3f358137"))
          }
          const expected = probedLength ?? declared
          if (maxBytes && expected !== undefined && expected > maxBytes) {
            discardBody(response)
            throw new Error($t("services.media.range-download.text_09fcdc7933"))
          }
          const opened = handle = await fs.open(temp, "wx")
          let received = 0
          for await (const chunk of readStream(response.body, transferSignal)) {
            const next = received + chunk.length
            if (maxBytes && next > maxBytes) throw new Error($t("services.media.range-download.text_09fcdc7933"))
            if (expected !== undefined && next > expected) throw new Error($t("services.media.range-download.text_9e3f358137"))
            await writeChunk(opened, chunk, received)
            received = next
          }
          if (!received || expected !== undefined && received !== expected) throw Object.assign(new Error($t("services.media.range-download.text_9d83213887")), { code: "ERR_STREAM_PREMATURE_CLOSE" })
          await opened.close()
          handle = undefined
          return received
        } catch (error) {
          try { await handle?.close(); handle = undefined } finally { await fs.rm(temp, { force: true }) }
          throw error
        }
      }, transferSignal)
    }
    try {
      const parsed = new URL(url)
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error($t("services.media.range-download.text_f0657608db"))
      const base = { "Accept-Encoding": "identity", ...headers }
      const probe = await probeRequest(parsed, { headers: { ...base, Range: "bytes=0-0" }, signal: transferSignal })
      let total: number
      if (probe.status === 200) total = await full(probe)
      else {
        const range = probe.headers.get("content-range")?.match(/^bytes 0-0\/(\d+)$/)
        discardBody(probe)
        if (probe.status !== 206 || !range) throw new Error($t("services.media.range-download.text_f31707a8ce", { "status": probe.status }))
        const resourceLength = total = Number(range[1])
        if (!Number.isSafeInteger(total) || total <= 0 || maxBytes && total > maxBytes) throw new Error($t("services.media.range-download.text_8e77c5f436"))
        const count = Math.max(1, Math.min(16, Math.floor(concurrency), Math.ceil(total / (2 * 1024 * 1024))))
        const validators = resourceValidators(probe.headers)
        if (count === 1) await full(() => request(url, { headers: base, signal: transferSignal }), resourceLength, validators)
        else {
          const opened = handle = await fs.open(temp, "wx"); await opened.truncate(total)
          const { etag, modified } = validators
          const validator = etag && !etag.startsWith("W/") ? etag : modified
          const ifRange: Record<string, string> = validator ? { "If-Range": validator } : {}
          const workers = Array.from({ length: count }, async (_, index) => {
            const start = Math.floor(resourceLength * index / count), end = Math.floor(resourceLength * (index + 1) / count) - 1
            let last
            for (let attempt = 0; attempt < 3; attempt++) {
              let retryAllowed = true
              try {
                transferSignal.throwIfAborted()
                const response = await request(url, { headers: { ...base, Range: `bytes=${start}-${end}`, ...ifRange }, signal: transferSignal })
                retryAllowed = response.status !== 429 && !response.headers.has("Retry-After")
                const expected = `bytes ${start}-${end}/${resourceLength}`
                if (!response.body || response.status !== 206 || response.headers.get("content-range") !== expected) {
                  discardBody(response)
                  throw new Error($t("services.media.range-download.text_2b8966c0f7"))
                }
                if (changesResource(response.headers, validators)) {
                  discardBody(response)
                  throw new Error($t("services.media.range-download.text_591ae276a0"))
                }
                let offset = start
                for await (const chunk of readStream(response.body, transferSignal)) {
                  if (offset + chunk.length > end + 1) throw new Error($t("services.media.range-download.text_2700acb207"))
                  await writeChunk(opened, chunk, offset)
                  offset += chunk.length
                }
                if (offset !== end + 1) throw new Error($t("services.media.range-download.text_04134e32e4"))
                return
              } catch (error) { last = error; if (transferSignal.aborted || !retryAllowed) break }
            }
            throw last
          })
          const results = await Promise.allSettled(workers.map(p => p.catch(error => { controller.abort(); throw error })))
          const failed = results.find(r => r.status === "rejected")
          if (failed) throw failed.reason
          await handle.sync(); await handle.close(); handle = undefined
        }
      }
      parentSignal.throwIfAborted()
      await fs.rename(temp, target)
      return { file: target, sizeBytes: total }
    } catch (error) { controller.abort(); lastError = error }
    finally {
      try { await handle?.close() } finally { await fs.rm(temp, { force: true }) }
    }
  }
  throw lastError || new Error($t("services.media.range-download.text_cbcfae0628"))
}
