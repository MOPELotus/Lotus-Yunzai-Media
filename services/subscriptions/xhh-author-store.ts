import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import YAML from "yaml"
import { readMigrationSourceFile } from "../../../../lib/migration-files.ts"
import { numericId, type SubscriptionRoute } from "./config.ts"
import type { LockSubscriptionFile } from "./types.ts"

const videoType = "DYNAMIC_TYPE_AV"
export const authorVideoType = videoType
const newestTime = 4102444800
const maxBytes = 512 * 1024
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"
const epoch = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= newestTime
  ? value : undefined

export type AuthorRoute = SubscriptionRoute & { kind: "group"; createdAfter: number; generation: string }
export type AuthorGroup = Pick<AuthorRoute, "chat" | "bot">
type Entry = Pick<AuthorRoute, "uid" | "name" | "createdAfter">
type AuthorGroupEntry = Entry & AuthorGroup & Pick<AuthorRoute, "generation">

function route(entry: AuthorGroupEntry): AuthorRoute {
  return { ...entry, kind: "group", types: [videoType] }
}

function validEntry(input: unknown): AuthorGroupEntry {
  if (!input || typeof input !== "object") throw new Error($t("services.subscriptions.xhh-author-store.text_277b5dda1b"))
  const { bot, chat, uid, name, createdAfter, generation } = input as Record<string, unknown>
  if (!numericId(bot) || !numericId(chat) || !numericId(uid) || typeof name !== "string" || name.length > 160 ||
      epoch(createdAfter) === undefined || typeof generation !== "string" || !/^[a-f0-9-]{36}$/u.test(generation)) {
    throw new Error($t("services.subscriptions.xhh-author-store.text_277b5dda1b"))
  }
  return { bot: String(bot), chat: String(chat), uid: String(uid), name, createdAfter: createdAfter as number, generation }
}

const inGroup = (entry: AuthorGroupEntry, group: AuthorGroup) => entry.chat === group.chat && entry.bot === group.bot

export function createAuthorVideoStore(data: string, lockFile: LockSubscriptionFile) {
  const directory = join(data, "yuki-plugin", "config", "bilibili")
  const path = join(directory, "author-videos.json")

  async function read(): Promise<AuthorGroupEntry[]> {
    try {
      const file = await lstat(path)
      if (!file.isFile() || file.size > maxBytes) throw new Error($t("services.subscriptions.xhh-author-store.text_34758b7513"))
      const input: { version?: unknown; routes?: unknown } = JSON.parse(await readFile(path, "utf8"))
      if (input?.version !== 1 || !Array.isArray(input.routes)) throw new Error($t("services.subscriptions.xhh-author-store.text_34758b7513"))
      const entries = input.routes.map(validEntry)
      if (new Set(entries.map(entry => [entry.bot, entry.chat, entry.uid].join(":"))).size !== entries.length) {
        throw new Error($t("services.subscriptions.xhh-author-store.text_d76e68ecd8"))
      }
      return entries
    } catch (error) {
      if (missing(error)) return []
      throw error
    }
  }

  async function change(operation: (entries: AuthorGroupEntry[]) => number, signal: AbortSignal) {
    signal.throwIfAborted()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const lock = await lockFile(join(directory, ".author-videos-lock.sqlite"), $t("services.subscriptions.xhh-author-store.text_2c9a6ede8f"))
    try {
      const entries = await read()
      const count = operation(entries)
      if (!count) return 0
      const bytes = JSON.stringify({ version: 1, routes: entries }, null, 2) + "\n"
      if (Buffer.byteLength(bytes) > maxBytes) throw new Error($t("services.subscriptions.xhh-author-store.text_26772099f5"))
      const pending = path + "." + crypto.randomUUID() + ".tmp"
      try {
        const output = await open(pending, "wx", 0o600)
        try { await output.writeFile(bytes) } finally { await output.close() }
        signal.throwIfAborted()
        await rename(pending, path)
      } finally {
        await rm(pending, { force: true })
      }
      return count
    } finally {
      lock.close()
    }
  }

  return {
    async routes() { return (await read()).map(route) },
    add(group: AuthorGroup, additions: readonly Entry[], signal: AbortSignal) {
      return change(entries => {
        let added = 0
        for (const entry of additions) {
          if (entries.some(current => inGroup(current, group) && current.uid === entry.uid)) continue
          entries.push(validEntry({ ...entry, ...group, generation: crypto.randomUUID() }))
          added++
        }
        return added
      }, signal)
    },
    remove(group: AuthorGroup, uid: string, signal: AbortSignal) {
      return change(entries => {
        const index = entries.findIndex(entry => inGroup(entry, group) && entry.uid === uid)
        if (index < 0) return 0
        entries.splice(index, 1)
        return 1
      }, signal)
    },
    checkpoint(route: AuthorRoute, completed: number, signal: AbortSignal) {
      return change(entries => {
        const entry = entries.find(entry => inGroup(entry, route) && entry.uid === route.uid &&
          entry.generation === route.generation && entry.createdAfter === route.createdAfter)
        if (!entry || epoch(completed) === undefined || completed <= entry.createdAfter) return 0
        entry.createdAfter = completed
        return 1
      }, signal)
    },
  }
}

export async function readLegacyAuthorVideos(root: string, group: string, now: number, signal: AbortSignal) {
  for (const base of ["backup/plugins", "plugins"]) {
    const directory = join(root, base, "xhh", "config")
    const file = await readMigrationSourceFile(root, join(directory, "bili_group.yaml"), maxBytes, signal)
    if (!file) continue
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    const data: unknown = YAML.parse(text, { intAsBigInt: true, maxAliasCount: 0 })
    if (!data || typeof data !== "object" || Array.isArray(data)) return []
    const rows = data as Record<string, unknown>
    return Object.entries(rows).flatMap(([uid, groups]) => {
      if (!numericId(uid) || !Array.isArray(groups) || !groups.some(item => numericId(item) === group)) return []
      const old = rows[uid + "_time"]
      const parsed = typeof old === "bigint" || typeof old === "string" && /^\d+$/u.test(old) ? Number(old) : old
      const checkpoint = epoch(parsed)
      return [{ uid, name: uid, createdAfter: checkpoint && checkpoint <= now ? checkpoint : now }]
    })
  }
  return []
}
