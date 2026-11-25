import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { discardBody, readStream } from "../media/transfer.ts"
import { withReadRetries } from "@lotus-yunzai/http"

export type DouyinFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface RequestOptions {
  fetch?: DouyinFetch
  timeoutMs?: number
  signal?: AbortSignal
}

export class DouyinError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export async function requestText(fetchImpl: DouyinFetch, url: string, options: RequestInit = {}, { timeoutMs = 15000, maxBytes = 4 * 1024 * 1024, headersOnly = false } = {}) {
  const request = withReadRetries((target, init) => fetchImpl(target.href, init))
  const controller = new AbortController()
  const active = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    active.throwIfAborted()
    const response = await request(new URL(url), { ...options, signal: active })
    if (active.aborted) {
      discardBody(response)
      active.throwIfAborted()
    }
    if (headersOnly || options.redirect === "manual" && response.status >= 300 && response.status < 400) {
      discardBody(response)
      return { response, text: "" }
    }
    if (Number(response.headers.get("content-length")) > maxBytes) {
      discardBody(response)
      throw new DouyinError("response_too_large", $t("services.douyin.http.text_f923227784"))
    }
    const chunks: Buffer[] = []
    let length = 0
    if (response.body) {
      for await (const chunk of readStream(response.body, active)) {
        length += chunk.length
        if (length > maxBytes) { controller.abort(); throw new DouyinError("response_too_large", $t("services.douyin.http.text_f923227784")) }
        chunks.push(Buffer.from(chunk))
      }
    }
    return { response, text: Buffer.concat(chunks).toString("utf8") }
  } catch (error) {
    const timedOut = controller.signal.aborted
    controller.abort()
    options.signal?.throwIfAborted()
    if (error instanceof DouyinError) throw error
    throw new DouyinError(timedOut ? "timeout" : "network", timedOut ? $t("services.douyin.http.text_944a4f8067") : $t("services.douyin.http.text_3182a3c07d"), { cause: error })
  } finally { clearTimeout(timer) }
}
