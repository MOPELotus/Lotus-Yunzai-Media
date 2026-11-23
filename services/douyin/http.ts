export type DouyinFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface RequestOptions {
  fetch?: DouyinFetch
  timeoutMs?: number
}

export class DouyinError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

export async function requestText(fetchImpl: DouyinFetch, url: string, options: RequestInit = {}, { timeoutMs = 15000, maxBytes = 4 * 1024 * 1024, headersOnly = false } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal })
    if (headersOnly) {
      await response.body?.cancel()
      return { response, text: "" }
    }
    if (Number(response.headers.get("content-length")) > maxBytes) throw new DouyinError("response_too_large", "抖音响应超过大小限制")
    const chunks: Buffer[] = []
    let length = 0
    if (response.body) {
      for await (const chunk of response.body) {
        length += chunk.length
        if (length > maxBytes) { controller.abort(); throw new DouyinError("response_too_large", "抖音响应超过大小限制") }
        chunks.push(Buffer.from(chunk))
      }
    }
    return { response, text: Buffer.concat(chunks).toString("utf8") }
  } catch (error) {
    const timedOut = controller.signal.aborted
    controller.abort()
    if (error instanceof DouyinError) throw error
    throw new DouyinError(timedOut ? "timeout" : "network", timedOut ? "抖音请求超时" : "抖音网络请求失败", { cause: error })
  } finally { clearTimeout(timer) }
}
