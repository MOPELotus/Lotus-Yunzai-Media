import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
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
    if (!response.ok) throw new Error($t("core.render.image.text_e929e6d826", { "status": response.status }))
    if (musicCover && !/^image\/(?:jpe?g|png|webp|avif)(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) {
      throw new Error($t("core.render.image.text_c1157992a4"))
    }
    if (Number(response.headers.get("content-length")) > maxBytes) throw new Error($t("core.render.image.text_765aee6a8e"))
    const chunks = []
    let size = 0
    for await (const chunk of response.body || []) {
      active.throwIfAborted()
      size += chunk.length
      if (size > maxBytes) throw new Error($t("core.render.image.text_765aee6a8e"))
      chunks.push(Buffer.from(chunk))
    }
    if (!size) throw new Error($t("core.render.image.text_93d6a33833"))
    return Buffer.concat(chunks)
  } catch (error) {
    if (controller.signal.aborted) throw new Error($t("core.render.image.text_f487a3c3cd"), { cause: error })
    throw error
  } finally { clearTimeout(timer); controller.abort() }
}
