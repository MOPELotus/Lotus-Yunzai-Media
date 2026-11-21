import { fetchCdn, type MediaFetch } from "../../services/media/cdn.ts"

interface ImageFetchOptions {
  readonly fetch?: MediaFetch
  readonly timeoutMs?: number
  readonly maxBytes?: number
}

/** Bound both image headers and body; native canvas URL loading has no task timeout. */
export async function fetchImageBytes(url: string, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000, maxBytes = 16 * 1024 * 1024 }: ImageFetchOptions = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchCdn(fetchImpl, url, { signal: controller.signal }, "image")
    if (!response.ok) throw new Error(`图片请求 HTTP ${response.status}`)
    if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("图片超过渲染大小限制")
    const chunks = []
    let size = 0
    for await (const chunk of response.body || []) {
      size += chunk.length
      if (size > maxBytes) throw new Error("图片超过渲染大小限制")
      chunks.push(Buffer.from(chunk))
    }
    if (!size) throw new Error("图片响应为空")
    return Buffer.concat(chunks)
  } catch (error) {
    if (controller.signal.aborted) throw new Error("图片下载超时", { cause: error })
    throw error
  } finally { clearTimeout(timer); controller.abort() }
}
