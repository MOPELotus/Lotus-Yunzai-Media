import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
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
          throw new TemporaryResponse($t("services.media.stream-retry.text_30727abc24", { "status": response.status }))
        }
      }))
    } catch (error) {
      if (signal.aborted || attempt >= 2 || !allowed || !(error instanceof TemporaryResponse || transientReadError(error))) throw error
      await delay(250 * (attempt + 1), undefined, { signal })
    }
  }
}
