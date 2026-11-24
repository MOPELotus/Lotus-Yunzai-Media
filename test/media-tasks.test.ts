import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { createMediaTask, recoverMediaTasks, releaseMediaTask } from "../services/media/tasks.ts"

const taskMarker = ".lotus-media-task.json"
const processMarker = ".lotus-media-process.json"

test("同类同名媒体任务各占一份目录，释放失败一侧不会删另一侧或外部文件", async () => {
  const base = await mkdtemp(join(tmpdir(), "lotus-media-invocations-"))
  try {
    const root = join(base, "tasks"), outside = join(base, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "video"), "outside")
    const tasks = await Promise.all([createMediaTask(root), createMediaTask(root)])
    const [first, second] = tasks
    expect(first.id).not.toBe(second.id)
    await Promise.all(tasks.map((task, i) => writeFile(join(task.dir, "same-video.mp4"), String(i))))
    await symlink(outside, join(root, "task-link"), "dir")
    await mkdir(join(first.dir, "nested"))
    for (const dir of [undefined, root, outside, join(first.dir, "nested"), join(root, "task-link")]) {
      await expect(releaseMediaTask(root, dir)).rejects.toThrow()
    }
    await releaseMediaTask(root, first.dir)
    await releaseMediaTask(root, first.dir)
    expect(await readFile(join(second.dir, "same-video.mp4"), "utf8")).toBe("1")
    expect(await readFile(join(outside, "video"), "utf8")).toBe("outside")
    await releaseMediaTask(root, second.dir)
    expect(await readdir(root)).toEqual(["task-link"])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("只能主动释放本次进程创建且身份标记相符的任务", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-media-owners-"))
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })
  const started = once(child, "spawn"), exited = once(child, "exit")
  try {
    await started
    const owner = { version: 1, id: "legacy", pid: process.pid, host: hostname() }
    for (const [name, marker] of [
      ["保留目录", JSON.stringify(owner)],
      ["task-malformed", "旧文件中的一行说明"],
      ["task-foreign", JSON.stringify({ ...owner, host: "另一台主机" })],
      ["task-other-process", JSON.stringify({ ...owner, pid: child.pid })],
      ["task-same-pid", JSON.stringify(owner)],
    ] as const) {
      const dir = join(root, name)
      await mkdir(dir)
      await writeFile(join(dir, taskMarker), marker)
      await writeFile(join(dir, "original.mp4"), "keep")
      await expect(releaseMediaTask(root, dir)).rejects.toThrow()
      expect(await readFile(join(dir, "original.mp4"), "utf8")).toBe("keep")
    }
    const current = await createMediaTask(root)
    const markerPath = join(current.dir, taskMarker)
    const raw = await readFile(markerPath, "utf8")
    await writeFile(markerPath, JSON.stringify({ ...JSON.parse(raw), id: "obsolete" }))
    await expect(releaseMediaTask(root, current.dir)).rejects.toThrow()
    await writeFile(markerPath, raw)
    await releaseMediaTask(root, current.dir)
    expect(await readdir(root)).not.toContain(current.id)
  } finally {
    child.kill()
    await exited
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== "linux")("恢复只清理同主机已退出的所有者和子进程组，未知状态继续保留", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-media-recovery-"))
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" })
  const running = once(child, "spawn")
  const finished = once(child, "exit")
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" })
  const deadFinished = once(dead, "exit")
  try {
    await Promise.all([running, deadFinished])
    const write = async (name: string, owner: unknown, subprocess?: unknown) => {
      const dir = join(root, name)
      await mkdir(dir)
      if (owner !== undefined) await writeFile(join(dir, taskMarker), typeof owner === "string" ? owner : JSON.stringify(owner))
      if (subprocess !== undefined) await writeFile(join(dir, processMarker), typeof subprocess === "string" ? subprocess : JSON.stringify(subprocess))
    }
    const owner = { version: 1, pid: dead.pid, host: hostname() }
    await Promise.all([
      write("task-owner-live", { ...owner, pid: process.pid }),
      write("task-group-live", owner, { state: "running", pid: child.pid }),
      write("task-starting", owner, { state: "starting" }),
      write("task-bad-process", owner, "<broken>"),
      write("task-unverifiable-process", owner),
      write("task-no-owner", undefined),
      write("task-bad-owner", "<broken>"),
      write("task-foreign", { ...owner, host: "different-host" }),
      write("task-group-dead", owner, { state: "running", pid: dead.pid }),
      write("task-dead", owner),
      write("keep-not-task", owner),
    ])
    await symlink(join(root, "missing-process-status"), join(root, "task-unverifiable-process", processMarker), "file")
    expect(await recoverMediaTasks(root)).toEqual({ removed: 2, retained: 9 })
    process.kill(-child.pid!, "SIGTERM")
    await finished
    expect(await recoverMediaTasks(root)).toEqual({ removed: 1, retained: 8 })
    expect((await readdir(root)).sort()).toEqual(["keep-not-task", "task-bad-owner", "task-bad-process",
      "task-foreign", "task-no-owner", "task-owner-live", "task-starting", "task-unverifiable-process"])
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(-child.pid, "SIGKILL")
    await finished.catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
