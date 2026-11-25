import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { setTimeout as delay } from "node:timers/promises"
import { Job } from "node-schedule"
import type { BotNotifications, CheckinNotifyDelivery } from "../../../../lib/checkin-notify.ts"
import type { CommandContext } from "../../../../lib/commands.ts"
import type { MessageReply } from "../../../../lib/messages.ts"
import type { GetSubscriptionRedis } from "../subscriptions/types.ts"
import { createOfficialVideoFeed } from "./feed.ts"
import { createOfficialVideoSettings } from "./settings.ts"
import type { OfficialVideoGame } from "./settings.ts"

interface Services {
  readonly signal?: AbortSignal
  readonly mediaRuntime?: {
    whenReady(start: () => void): () => void
    registerOfficialVideoTask?: (cron: string, run: () => Promise<void>) => () => void | Promise<void>
  }
  readonly subscriptionTransport?: () => readonly BotNotifications[]
  readonly allowOfficialVideoGroup?: (bot: number, group: number) => boolean
}

const claim = `
if redis.call('EXISTS',KEYS[1])>0 or (tonumber(redis.call('GET',KEYS[2])) or 0)>=tonumber(ARGV[3]) then return 0 end
redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]); return 1`
const settle = `
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
if ARGV[2]=='rejected' then return redis.call('DEL',KEYS[1]) end
local current=tonumber(redis.call('GET',KEYS[2])) or 0
if current<tonumber(ARGV[3]) then redis.call('SET',KEYS[2],ARGV[3]) end
redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL'); return 1`
const hold = String(86400 * 90)
const cron = "30 */3 * * * *"

export function createOfficialVideoCommands(services: Services, {
  config = createOfficialVideoSettings(), feed = createOfficialVideoFeed(),
  getRedis = () => (globalThis as { redis?: ReturnType<GetSubscriptionRedis> }).redis,
  wait = (milliseconds: number, signal: AbortSignal) => delay(milliseconds, undefined, { signal }),
}: {
  config?: ReturnType<typeof createOfficialVideoSettings>
  feed?: ReturnType<typeof createOfficialVideoFeed>
  getRedis?: GetSubscriptionRedis
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
} = {}) {
  const stopped = new AbortController()
  const signal = services.signal ? AbortSignal.any([services.signal, stopped.signal]) : stopped.signal
  const allowedGroup = (bot: number, group: number) => services.allowOfficialVideoGroup?.(bot, group) !== false
  let running: Promise<void> | undefined
  let job: Job | undefined
  const cancelScheduled = services.mediaRuntime?.registerOfficialVideoTask?.(cron, async () => { await run() })
  const cancelReady = cancelScheduled ? undefined : services.mediaRuntime?.whenReady(() => {
    if (!signal.aborted) {
      job = new Job(() => { void run() })
      job.schedule({ rule: cron, tz: "Asia/Shanghai" })
    }
  })

  async function collect(games: Awaited<ReturnType<typeof config.settings>>["games"]) {
    const results = await Promise.allSettled(games.map(game => feed.fetchGame(game, signal)))
    return { items: results.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : []),
      failed: results.filter(result => result.status === "rejected").length }
  }

  const matches = (message: string) => /^#最新视频(?:\s|$)/u.test(message)
  async function fallback(message: string, context: CommandContext) {
    if (!matches(message)) return
    if (message.slice(5).trim()) return $t("services.official-video.index.text_f660be47d4")
    if (signal.aborted) return []
    try {
      const settings = await config.settings()
      const muted = context.message_type === "group" ? settings.muted.get(context.group_id ?? 0) : undefined
      const { items, failed } = await collect(settings.games.filter(game => !muted?.has(game)))
      signal.throwIfAborted()
      if (!items.length) return failed ? $t("services.official-video.index.text_5212fa144a") : $t("services.official-video.index.text_9a0e95ac08")
      const nodes = (await Promise.all(items.map(item => feed.messages(item, settings.cover, signal)))).flat()
      if (settings.forward || !context.reply) return { type: "forward" as const, nodes }
      for (const [index, node] of nodes.entries()) {
        signal.throwIfAborted()
        if (index) await wait(200, signal)
        await context.reply(node)
      }
      return []
    } catch { return signal.aborted ? [] : $t("services.official-video.index.text_5212fa144a") }
  }

  function run() {
    if (signal.aborted) return
    running ??= poll().catch(error => {
      if (!signal.aborted) console.warn($t("services.official-video.index.text_aa1292c0a1"), error instanceof Error ? error.message : String(error))
    }).finally(() => { running = undefined })
    return running
  }

  async function poll() {
    const redis = getRedis()
    const sessions = services.subscriptionTransport?.() ?? []
    if (!redis || !sessions.length) return
    const settings = await config.settings()
    if (!settings.groups.length) return
    const { items } = await collect(settings.games)
    const oldCutoffs = new Map(await Promise.all(items.map(async item => {
      const val = Number(await redis.get(`xhh_vid:${item.game}`))
      return [item.game, Number.isSafeInteger(val) && val > 0 ? val : 0] as const
    })))
    const prepared = new Map<string, readonly MessageReply[]>()
    let attempted = false
    for (const group of settings.groups) {
      signal.throwIfAborted()
      let session: BotNotifications | undefined
      for (const candidate of sessions) {
        if (allowedGroup(candidate.botId, group) && await candidate.isGroupMember(group, candidate.botId).catch(() => false)) { session = candidate; break }
      }
      if (!session) continue
      const current = await config.settings()
      if (!current.groups.includes(group)) continue
      const eligible = items.filter(item => current.games.includes(item.game) && !current.muted.get(group)?.has(item.game) &&
        item.published > (oldCutoffs.get(item.game) ?? 0))
      if (!eligible.length) continue
      const selected: { keys: string[]; token: string; published: string; nodes: readonly MessageReply[]; game: OfficialVideoGame }[] = []
      const finish = (entry: typeof selected[number], outcome: CheckinNotifyDelivery) =>
        redis.eval(settle, { keys: entry.keys, arguments: [entry.token, outcome, entry.published] })
      try {
        for (const item of eligible) {
          signal.throwIfAborted()
          const cache = `${item.game}:${item.id}:${current.cover}`
          const nodes = prepared.get(cache) ?? await feed.messages(item, current.cover, signal)
          prepared.set(cache, nodes)
          const base = `lotus:media:official-video:${group}:${item.game}`
          const keys = [`${base}:${item.id}`, `${base}:latest`]
          const token = `pending:${crypto.randomUUID()}`
          const published = String(item.published)
          if (await redis.eval(claim, { keys, arguments: [token, hold, published] }) === 1) selected.push({ keys, token, published, nodes, game: item.game })
        }
        if (!selected.length) continue
        if (attempted) await wait(10_000 + Math.floor(Math.random() * 10_001), signal)
        const active = await config.settings()
        if (!active.groups.includes(group) || !allowedGroup(session.botId, group) ||
            !await session.isGroupMember(group, session.botId).catch(() => false) || signal.aborted ||
            !allowedGroup(session.botId, group)) continue
        attempted = true
        const allowed = selected.filter(entry => active.games.includes(entry.game) && !active.muted.get(group)?.has(entry.game))
        if (active.forward && session.sendForward) {
          if (allowed.length && !signal.aborted) {
            const result = await session.sendForward({ groupId: group }, allowed.flatMap(entry => entry.nodes)).catch(() => "unknown" as const)
            for (const entry of allowed) await finish(entry, result)
          }
        } else {
          for (const entry of allowed) {
            let outcome: CheckinNotifyDelivery = "rejected"
            let confirmed = 0
            for (const node of entry.nodes) {
              if (signal.aborted || !allowedGroup(session.botId, group)) {
                if (confirmed) outcome = "unknown"
                break
              }
              const result = await session.sendGroup(group, node).catch(() => "unknown" as const)
              outcome = result === "rejected" && confirmed ? "unknown" : result
              if (result !== "confirmed") break
              confirmed++
              if (entry.nodes.length > 1 && node !== entry.nodes.at(-1)) await wait(200, signal).catch(() => {})
            }
            await finish(entry, outcome)
          }
        }
      } finally {
        for (const entry of selected) await finish(entry, "rejected")
      }
    }
  }

  return { matches, fallback, run, async dispose() {
    stopped.abort()
    cancelReady?.()
    job?.cancel()
    await Promise.all([cancelScheduled?.(), running])
  } }
}
