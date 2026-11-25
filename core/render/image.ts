import { readPublicResponse } from "../../services/public-read.ts"
import { acfunImageUrl, fetchCdn, weixinChannelsImageUrl, type MediaFetch, type MusicCoverCdn } from "../../services/media/cdn.ts"

interface ImageFetchOptions {
  readonly fetch?: MediaFetch
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly signal?: AbortSignal
  readonly musicCover?: MusicCoverCdn
}

/** Bound both image headers and body; native canvas URL loading has no task timeout. */
export async function fetchImageBytes(url: string, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000, maxBytes = 16 * 1024 * 1024,
  signal, musicCover }: ImageFetchOptions = {}) {
  const controller = new AbortController()
  const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    active.throwIfAborted()
    const response = await fetchCdn((target, options) => readPublicResponse(fetchImpl, target, options), url, { signal: active }, musicCover ??
      (acfunImageUrl(url) ? "acfun-image" : weixinChannelsImageUrl(url) ? "weixin-channels-image" : "image"))
    if (!response.ok) throw new Error(`图片请求 HTTP ${response.status}`)
    if (musicCover && !/^image\/(?:jpe?g|png|webp|avif)(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) {
      throw new Error("封面响应未提供受支持的图片格式。")
    }
    if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("图片超过渲染大小限制")
    const chunks = []
    let size = 0
    for await (const chunk of response.body || []) {
      active.throwIfAborted()
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
