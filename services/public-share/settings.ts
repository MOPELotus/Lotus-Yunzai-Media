import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { lockFile } from "../../../../lib/file-lock.ts"
import { readMigrationSourceFile } from "../../../../lib/migration-files.ts"
import { dataPath, rootPath } from "../../core/path.ts"

const oldController = "通用（包含快手等）"
export type PublicShareSettings = { enable: boolean; private: boolean }
type Platform = "pipixia" | "kuaishou" | "jike" | "xigua"

function mapping(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function legacyGeneralShareSettings(currentTools: Readonly<Record<string, unknown>> = {}, root = rootPath): Promise<PublicShareSettings> {
  let legacy: Record<string, unknown> = {}
  if (currentTools.globalBlackList == null || currentTools.privateResolve == null) {
    for (const base of ["backup/plugins/rconsole-plugin", "plugins/rconsole-plugin"]) {
      const source = await readMigrationSourceFile(root, join(root, base, "config/tools.yaml"), 256 * 1024)
      if (!source) continue
      legacy = mapping(Bun.YAML.parse(source.bytes.toString("utf8")))
      break
    }
  }
  const blacklist = currentTools.globalBlackList ?? legacy.globalBlackList
  return {
    enable: !(Array.isArray(blacklist) && blacklist.some(value => value === oldController || value === "general")),
    private: (currentTools.privateResolve ?? legacy.privateResolve) === true,
  }
}

export function createPublicShareSettings(platform: Platform, label: string, directory = dataPath, root = rootPath) {
  const file = join(directory, "media", platform + ".yaml")
  async function read() {
    try {
      const config: unknown = Bun.YAML.parse(await readFile(file, "utf8"))
      if (config == null) return {}
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(label + "配置须为映射。")
      return mapping(config)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw error
    }
  }

  async function settings(currentTools: Readonly<Record<string, unknown>> = {}): Promise<PublicShareSettings> {
    const saved = await read()
    if (typeof saved.enable === "boolean" && typeof saved.private === "boolean") return { enable: saved.enable, private: saved.private }
    const legacy = await legacyGeneralShareSettings(currentTools, root)
    return {
      enable: typeof saved.enable === "boolean" ? saved.enable : legacy.enable,
      private: typeof saved.private === "boolean" ? saved.private : legacy.private,
    }
  }

  async function save(patch: Partial<PublicShareSettings>) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const lock = await lockFile(file + ".sqlite", label + "配置")
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
