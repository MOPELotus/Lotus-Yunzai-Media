import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { readOptionalConfigFile } from "../../../../lib/config.ts"
import { lockFile } from "../../../../lib/file-lock.ts"
import { dataPath, rootPath } from "../../core/path.ts"

export const officialLinkToggles = [
  ["youtube", "YouTube 链接预览"], ["youtubeMusic", "YouTube Music 链接预览"],
  ["telegram", "Telegram 公开消息预览"], ["v2ex", "V2EX 主题预览"], ["private", "允许在私聊预览"],
] as const
export type OfficialLinkToggle = typeof officialLinkToggles[number][0]
export type OfficialLinkSettings = Readonly<Record<OfficialLinkToggle, boolean>> & {
  readonly trustedTelegramUsers: readonly string[]
}
export type OfficialLinkPatch = Partial<Record<OfficialLinkToggle, boolean>> & { trustedTelegramUsers?: readonly string[] }
const legacyTrustKey = "Yz:rconsole:tools:whitelist"
const maxTrustUsers = 1000
const qqId = /^[1-9]\d{0,18}$/u

export function parseTrustedTelegramUsers(value: unknown, allowLegacy = false): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > maxTrustUsers) return
  const users = new Set<string>()
  for (const raw of value) {
    const id = typeof raw === "string" ? raw : allowLegacy && typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : ""
    if (qqId.test(id)) users.add(id)
    else if (!allowLegacy) return
  }
  return [...users]
}

const runtimeRedis = () => (globalThis as { redis?: { get(key: string): Promise<string | null> } }).redis
export function createOfficialLinkSettings(directory = dataPath, root = pathToFileURL((directory === dataPath ? rootPath : directory) + "/"),
  getRedis = runtimeRedis) {
  const file = join(directory, "media", "official-links.yaml")
  async function read(): Promise<Record<string, unknown>> {
    try {
      const raw: unknown = Bun.YAML.parse(await readFile(file, "utf8"))
      if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>
      throw new Error("公开链接预览设置须为映射。")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw error
    }
  }

  async function legacyTrust(): Promise<readonly string[]> {
    try {
      const raw = await getRedis()?.get(legacyTrustKey)
      return raw && raw.length <= 64 * 1024 ? parseTrustedTelegramUsers(JSON.parse(raw), true) ?? [] : []
    } catch { return [] }
  }

  async function settings(includeTrusted = true): Promise<OfficialLinkSettings> {
    const raw = await read()
    const legacy = officialLinkToggles.some(([key]) => typeof raw[key] !== "boolean") ||
        (includeTrusted && !Object.hasOwn(raw, "trustedTelegramUsers"))
      ? await readOptionalConfigFile(root, "plugins/rconsole-plugin/config/tools.yaml") ??
        await readOptionalConfigFile(root, "backup/plugins/rconsole-plugin/config/tools.yaml")
      : undefined
    const blocked = Array.isArray(legacy?.globalBlackList) ? legacy.globalBlackList : []
    const flag = (key: OfficialLinkToggle, inherited: boolean) => typeof raw[key] === "boolean" ? raw[key] as boolean : inherited
    const trustedTelegramUsers = !includeTrusted ? [] : Object.hasOwn(raw, "trustedTelegramUsers")
      ? parseTrustedTelegramUsers(raw.trustedTelegramUsers) ?? [] : legacy ? await legacyTrust() : []
    return {
      youtube: flag("youtube", !blocked.includes("YouTube")), youtubeMusic: flag("youtubeMusic", !blocked.includes("YouTube")),
      telegram: flag("telegram", !blocked.includes("小飞机")), v2ex: flag("v2ex", !blocked.includes("AI总结")),
      private: flag("private", legacy?.privateResolve === true),
      trustedTelegramUsers,
    }
  }

  async function save(patch: OfficialLinkPatch) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const lock = await lockFile(file + ".sqlite", "公开链接预览设置")
    const temporary = file + "." + crypto.randomUUID() + ".tmp"
    try {
      await writeFile(temporary, Bun.YAML.stringify({ ...await read(), ...patch }), { mode: 0o600, flag: "wx" })
      await rename(temporary, file)
    } finally {
      try { await rm(temporary, { force: true }) } finally { lock.close() }
    }
  }

  return { settings, save }
}
