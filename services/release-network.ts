import { setTimeout as sleep } from "node:timers/promises"
import { emitTaskProgress, type TaskProgressHandler } from "./progress.ts"

export class ReleaseHttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`) }
}

/** Only transport failures and explicitly temporary HTTP responses are retryable. */
export function temporaryReleaseFailure(error: unknown): boolean {
  if (error instanceof ReleaseHttpError) return [408, 425, 429, 500, 502, 503, 504].includes(error.status)
  if (!(error instanceof Error)) return false
  const code = "code" in error ? String(error.code) : ""
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code)) return true
  if (error.name === "TimeoutError") return true
  if (error.cause instanceof Error && error.cause !== error) return temporaryReleaseFailure(error.cause)
  return /(?:fetch failed|socket connection was closed unexpectedly|connection reset|network connection (?:was )?lost)/iu.test(error.message)
}

export function releaseFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = "code" in error ? String(error.code) : undefined
  const cause = error.cause instanceof Error ? releaseFailure(error.cause) : undefined
  return [code, error.message, cause].filter((value, index, values) => value && values.indexOf(value) === index).join(": ")
}

export async function retryReleaseRequest<T>(work: () => Promise<T>, { label, url, signal, onTaskProgress, attempts = 3 }: {
  label: string; url: string; signal?: AbortSignal; onTaskProgress?: TaskProgressHandler; attempts?: number
}): Promise<T> {
  const host = new URL(url).host
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    emitTaskProgress(onTaskProgress, { stage: "release-request", message: `${label}（${host}，尝试 ${attempt}/${attempts}）` })
    try { return await work() } catch (error) {
      signal?.throwIfAborted()
      const reason = releaseFailure(error)
      if (!temporaryReleaseFailure(error) || attempt >= attempts) {
        throw new Error(`${label}失败（${host}，已尝试 ${attempt} 次）：${reason}`, { cause: error })
      }
      emitTaskProgress(onTaskProgress, { stage: "release-retry", message: `${label}暂时失败（${host}）：${reason}；即将重试 ${attempt + 1}/${attempts}` })
      await sleep(500 * attempt, undefined, { signal })
    }
  }
}
