import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"

function processIsLive(pid: number) {
  try { process.kill(pid, 0); return true } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

function absent(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
}

const MARKER = ".lotus-media-task.json"
const ownedTasks = new Map<string, string>()

async function readMarker(dir: string, name: string) {
  const file = path.join(dir, name)
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.size > 4096) throw new Error("媒体任务标记无效")
  return record(JSON.parse(await fs.readFile(file, "utf8")))
}

function hasLocalOwner(marker: Record<string, unknown> | undefined): marker is Record<string, unknown> & { pid: number } {
  return marker?.version === 1 && marker.host === os.hostname() && validPid(marker.pid)
}

async function readTaskOwner(dir: string) {
  const stat = await fs.lstat(dir).catch(error => {
    if (absent(error)) return null
    throw error
  })
  if (!stat) return
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("媒体任务目录无效")
  const owner = await readMarker(dir, MARKER)
  if (!hasLocalOwner(owner)) throw new Error("无法核实本机媒体任务标记")
  return owner
}

function removeTaskDirectory(dir: string) {
  return fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}

export function isInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** A directory is owned by one invocation, never by a video ID or a group. */
export async function createMediaTask(root: string) {
  await fs.mkdir(root, { recursive: true })
  const dir = await fs.mkdtemp(path.join(root, "task-"))
  try {
    const id = randomUUID()
    await fs.writeFile(path.join(dir, MARKER), JSON.stringify({
      version: 1, id, pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(),
    }), { flag: "wx" })
    ownedTasks.set(path.resolve(dir), id)
    return { dir, id: path.basename(dir), root: path.resolve(root) }
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true })
    throw error
  }
}

export async function releaseMediaTask(root: string, dir: string | undefined) {
  if (!dir || !isInside(root, dir) || path.dirname(path.resolve(dir)) !== path.resolve(root) ||
      !path.basename(path.resolve(dir)).startsWith("task-")) {
    throw new Error("拒绝清理不属于当前媒体任务的目录")
  }
  const resolved = path.resolve(dir)
  const owner = await readTaskOwner(resolved)
  if (owner) {
    // Direct release is for tasks created by this runtime. Startup recovery handles exited owners separately.
    const id = ownedTasks.get(resolved)
    if (!id || owner.pid !== process.pid || owner.id !== id) throw new Error("媒体任务不属于当前运行进程")
    await removeTaskDirectory(resolved)
  }
  ownedTasks.delete(resolved)
}

/** Conservative recovery: unknown directories and any live owner/child stay untouched. */
export async function recoverMediaTasks(root: string) {
  const result = { removed: 0, retained: 0 }
  const logger = (globalThis as { logger?: Pick<Console, "info"> }).logger
  const report = () => {
    if (result.retained) logger?.info?.(`[media] Media recovery retained ${result.retained} active or unverifiable entries in ${root}`)
    if (result.removed) logger?.info?.(`[media] Media recovery removed ${result.removed} exited tasks in ${root}`)
    return result
  }
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
    if (absent(error)) return []
    throw error
  })
  // Every external media process is registered before spawning. On other platforms
  // there is no reliable process-group liveness check, so recovery stays conservative.
  if (process.platform !== "linux") { result.retained = entries.length; return report() }
  for (const entry of entries) {
    const dir = path.join(root, entry.name)
    if (!entry.isDirectory() || !entry.name.startsWith("task-")) { result.retained++; continue }
    try {
      const marker = await readTaskOwner(dir)
      if (!marker) {
        result.retained++; continue
      }
      const alive = processIsLive(marker.pid)
      let childAlive = false
      try {
        const child = await readMarker(dir, ".lotus-media-process.json")
        childAlive = child?.state !== "running" || !validPid(child.pid) || processIsLive(-child.pid)
      } catch (error) {
        if (!absent(error)) childAlive = true
      }
      if (alive || childAlive) { result.retained++; continue }
      await removeTaskDirectory(dir)
      result.removed++
    } catch { result.retained++ }
  }
  return report()
}
