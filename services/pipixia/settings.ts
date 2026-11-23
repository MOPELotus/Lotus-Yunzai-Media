import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { lockFile } from "../../../../lib/file-lock.ts"
import { readMigrationSourceFile } from "../../../../lib/migration-files.ts"
import { dataPath, rootPath } from "../../core/path.ts"

const oldController = "通用（包含快手等）"
export const pipixiaFields = [["enable", "解析皮皮虾链接"], ["private", "私聊自动解析"]] as const
export type PipixiaField = typeof pipixiaFields[number][0]
export type PipixiaSettings = Record<PipixiaField, boolean>

function mapping(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function createPipixiaSettings(directory = dataPath, root = rootPath) {
  const file = join(directory, "media", "pipixia.yaml")
  async function read() {
    try {
      const config: unknown = Bun.YAML.parse(await readFile(file, "utf8"))
      if (config == null) return {}
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("皮皮虾配置须为映射。")
      return mapping(config)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw error
    }
  }

  async function settings(currentTools: Readonly<Record<string, unknown>> = {}): Promise<PipixiaSettings> {
    const saved = await read()
    const legacy: Record<string, unknown> = {}
    if (typeof saved.enable !== "boolean" || typeof saved.private !== "boolean") {
      for (const base of ["backup/plugins/rconsole-plugin", "plugins/rconsole-plugin"]) {
        const source = await readMigrationSourceFile(root, join(root, base, "config/tools.yaml"), 256 * 1024)
        if (!source) continue
        const old = mapping(Bun.YAML.parse(source.bytes.toString("utf8")))
        legacy.globalBlackList = old.globalBlackList
        legacy.privateResolve = old.privateResolve
        break
      }
    }
    const blacklist = currentTools.globalBlackList ?? legacy.globalBlackList
    return {
      enable: typeof saved.enable === "boolean" ? saved.enable :
        !(Array.isArray(blacklist) && blacklist.some(value => value === oldController || value === "general")),
      private: typeof saved.private === "boolean" ? saved.private : (currentTools.privateResolve ?? legacy.privateResolve) === true,
    }
  }

  async function save(patch: Partial<PipixiaSettings>) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const lock = await lockFile(file + ".sqlite", "皮皮虾配置")
    try {
      const current = await read()
      const staged = file + "." + crypto.randomUUID() + ".tmp"
      try {
        await writeFile(staged, Bun.YAML.stringify({ ...current, ...patch }), { mode: 0o600, flag: "wx" })
        await rename(staged, file)
      } finally { await rm(staged, { force: true }) }
    } finally { lock.close() }
  }

  return { settings, save }
}
