import { setTimeout as delay } from "node:timers/promises"
import { transientReadError, transientReadResponse, withoutReadRetries } from "@lotus-yunzai/http"

class TemporaryResponse extends Error {}

/** The operation must close handles and remove partial files before it rejects. */
export async function retryStreamRead<T>(operation: (response: (value: Response) => void) => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    let allowed = true
    try {
      return await withoutReadRetries(() => operation(response => {
        allowed = response.status !== 429 && !response.headers.has("Retry-After")
        if (transientReadResponse(response)) {
          void response.body?.cancel().catch(() => undefined)
          throw new TemporaryResponse(`媒体下载失败 HTTP ${response.status}`)
        }
      }))
    } catch (error) {
      if (signal.aborted || attempt >= 2 || !allowed || !(error instanceof TemporaryResponse || transientReadError(error))) throw error
      await delay(250 * (attempt + 1), undefined, { signal })
    }
  }
}
