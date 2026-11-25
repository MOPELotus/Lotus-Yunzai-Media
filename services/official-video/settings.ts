import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { lockFile } from "../../../../lib/file-lock.ts"
import { dataPath, rootPath } from "../../core/path.ts"

export const officialVideoGames = {
  gs: { name: $t("services.official-video.settings.text_d1597c51ed"), uid: "75276539", forum: "ys" },
  sr: { name: $t("services.official-video.settings.text_a2927891f0"), uid: "288909600", forum: "sr" },
  zzz: { name: $t("services.official-video.settings.text_b1110352c9"), uid: "152039148", forum: "zzz" },
  bh3: { name: $t("services.official-video.settings.text_6d3d8653d7"), uid: "73565430", forum: "bh3" },
  by: { name: $t("services.official-video.settings.text_669908adb6"), uid: "448340772", forum: "by" },
  xbgd: { name: $t("services.official-video.settings.text_6f70b509e8"), uid: "378227988", forum: "xbgd" },
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
    const gate = await lockFile(file + ".sqlite", $t("services.official-video.settings.text_c35bfb374e"))
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
