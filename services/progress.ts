/** Observers must never interrupt downloads, verification or rollback. */
export interface TaskProgress {
  stage: string
  message: string
  completed?: number
  total?: number
  unit?: string
}
export type TaskProgressHandler = (event: TaskProgress) => unknown
export function emitTaskProgress(callback: TaskProgressHandler | undefined, event: TaskProgress) {
  try { void Promise.resolve(callback?.(event)).catch(() => undefined) } catch {}
}
export function responseBytes(response: Response): number | undefined {
  // Fetch transparently decompresses encoded responses, so their wire length is not comparable.
  if (response.headers.get("content-encoding")) return
  const value = Number(response.headers.get("content-length"))
  return Number.isFinite(value) && value > 0 ? value : undefined
}
