import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { lockFile } from "../../../../lib/file-lock.ts"
import { dataPath, rootPath } from "../../core/path.ts"

export const officialVideoGames = {
  gs: { name: "原神", uid: "75276539", forum: "ys" },
  sr: { name: "星铁", uid: "288909600", forum: "sr" },
  zzz: { name: "绝区零", uid: "152039148", forum: "zzz" },
  bh3: { name: "崩坏3", uid: "73565430", forum: "bh3" },
  by: { name: "崩坏因缘精灵", uid: "448340772", forum: "by" },
  xbgd: { name: "星布谷地", uid: "378227988", forum: "xbgd" },
} as const
export type OfficialVideoGame = keyof typeof officialVideoGames
const optionalGames = ["bh3", "by", "xbgd"] as const

function mapping(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function groupNumber(value: unknown) {
  const text = String(value)
  const number = Number(text)
  return /^[1-9]\d{0,15}$/u.test(text) && Number.isSafeInteger(number) ? number : undefined
}

function groups(value: unknown) {
  return [...new Set((Array.isArray(value) ? value : []).flatMap(item => groupNumber(item) ?? []))]
}

function isGame(value: unknown): value is OfficialVideoGame {
  return typeof value === "string" && Object.hasOwn(officialVideoGames, value)
}

async function read(path: string) {
  try { return mapping(Bun.YAML.parse(await readFile(path, "utf8"))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}

export function createOfficialVideoSettings(directory = dataPath, root = rootPath) {
  const file = join(directory, "media", "official-video.yaml")
  const legacyRoots = [join(root, "backup/plugins/xhh/config"), join(root, "plugins/xhh/config")]
  async function settings() {
    const modern = await read(file) ?? {}
    const [oldConfig, oldOther] = await Promise.all(["config.yaml", "other.yaml"].map(async name => {
      for (const base of legacyRoots) {
        const value = await read(join(base, name))
        if (value) return value
      }
    }))
    const muted = new Map<number, ReadonlySet<OfficialVideoGame>>()
    const rawMuted = modern.group_config ?? oldOther?.group_config
    if (Array.isArray(rawMuted)) {
      for (const line of rawMuted) {
        if (typeof line !== "string") continue
        const [group, ...games] = line.split(/[:：,，\s]+/u)
        const id = groupNumber(group)
        if (id) muted.set(id, new Set(games.filter(isGame)))
      }
    } else {
      for (const [rawId, games] of Object.entries(mapping(rawMuted))) {
        const id = groupNumber(rawId)
        if (id && Array.isArray(games)) muted.set(id, new Set(games.filter(isGame)))
      }
    }
    const selected = Object.fromEntries(optionalGames.map(key => [key, (modern[key] ?? oldOther?.[key]) === true]))
    return { groups: groups(modern.groups ?? oldConfig?.groups), muted,
      forward: (modern.forwardMsg ?? oldOther?.forwardMsg) !== false,
      cover: (modern.cover ?? oldOther?.cover) === true,
      games: (["gs", "sr", "zzz", ...optionalGames.filter(key => selected[key])] as readonly OfficialVideoGame[]),
      selected }
  }

  async function save(patch: Record<string, boolean | readonly string[]>) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const gate = await lockFile(file + ".sqlite", "官号视频设置")
    try {
      const current = await read(file) ?? {}
      const temporary = file + "." + crypto.randomUUID() + ".tmp"
      try {
        await writeFile(temporary, Bun.YAML.stringify({ ...current, ...patch }), { mode: 0o600, flag: "wx" })
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }) }
    } finally { gate.close() }
  }

  return { settings, save }
}
