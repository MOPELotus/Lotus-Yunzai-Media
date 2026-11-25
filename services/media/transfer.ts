import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import type { FileHandle } from "node:fs/promises"

export function discardBody(response: Response) {
  void response.body?.cancel().catch(() => {})
}

export async function* readStream(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      yield value
    }
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener("abort", cancel)
    cancel()
    reader.releaseLock()
  }
}

export async function writeChunk(file: FileHandle, chunk: Uint8Array, offset: number) {
  let written = 0
  while (written < chunk.length) {
    const result = await file.write(chunk, written, chunk.length - written, offset + written)
    if (!result.bytesWritten) throw new Error($t("services.media.transfer.text_bb53817e85"))
    written += result.bytesWritten
  }
}
