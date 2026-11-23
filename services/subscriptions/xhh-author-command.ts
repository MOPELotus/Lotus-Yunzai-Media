import { dirname } from "node:path"
import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import { isBiliVideoPage } from "../bilibili/service.ts"
import { numericId, type SubscriptionRoute, type SubscriptionSettings } from "./config.ts"
import { createSubscriptionDelivery } from "./delivery.ts"
import type { DynamicPost, LockSubscriptionFile, SubscriptionProvider } from "./types.ts"
import { authorVideoType, createAuthorVideoStore, readLegacyAuthorVideos, type AuthorRoute } from "./xhh-author-store.ts"

const platform = "(?:哔哩哔哩|b站|bilibili|bili)"
const edit = new RegExp("^[#/]?(添加|订阅|开启|取消|删除|关闭)" + platform + "视频推送\\s*(?:UID\\s*)?([1-9]\\d{0,19})?$", "iu")
const legacyEdit = new RegExp("^[#/]?(添加|开启|取消|删除|关闭)" + platform + "推送([1-9]\\d{0,19})?$", "iu")
const list = new RegExp("^[#/]" + platform + "视频推送列表$", "iu")
const migration = new RegExp("^[#/]迁移" + platform + "视频推送(?:\\s+([1-9]\\d{0,19}))?$", "iu")
const remove = /^(?:取消|删除|关闭)$/u
const feature = ["[media] B 站投稿订阅"] as const

type DeliveryServices = Pick<Parameters<typeof createSubscriptionDelivery>[0], "groups" | "notifications" | "getRedis" | "signal" | "now" | "render" | "wait">

export interface AuthorVideoOptions extends DeliveryServices {
  directory: string
  lockFile: LockSubscriptionFile
  provider: SubscriptionProvider
  settings(): Promise<SubscriptionSettings>
  quotedAuthor?: (context: MessageFallbackContext) => Promise<string | undefined>
}

function latestOriginalVideo(uid: string, posts: readonly DynamicPost[], wall: number) {
  let latest: DynamicPost | undefined
  for (const post of posts) {
    const target = URL.parse(post.url)
    if (post.uid !== uid || post.type !== authorVideoType || !target || !isBiliVideoPage(target) ||
        !Number.isSafeInteger(post.createdAt) || post.createdAt <= 0 || post.createdAt > wall ||
        latest && post.createdAt <= latest.createdAt) continue
    latest = post
  }
  return latest ? [latest] : []
}

function isAuthorRoute(route: SubscriptionRoute): route is AuthorRoute {
  return route.kind === "group" && "createdAfter" in route && typeof route.createdAfter === "number" &&
    "generation" in route && typeof route.generation === "string"
}

export function createAuthorVideoModule({ directory, lockFile, provider, settings, quotedAuthor, now = Date.now, ...delivery }: AuthorVideoOptions) {
  const store = createAuthorVideoStore(directory, lockFile)
  const destroyed = new AbortController()
  const active = delivery.signal ? AbortSignal.any([destroyed.signal, delivery.signal]) : destroyed.signal
  const source: SubscriptionProvider = { ...provider, async fetchPosts(uid, options) {
    const wall = Math.floor(now() / 1000)
    if (provider.fetchLatestAuthorVideo) {
      try {
        const archive = await provider.fetchLatestAuthorVideo(uid, options?.signal)
        if (!archive) return []
        // A dynamic may be disabled by its uploader. The author archive still lists the video.
        const feed = await provider.fetchPosts(uid, { ...options, oldest: wall + 1 }).catch(() => [])
        options?.signal?.throwIfAborted()
        const same = feed.find(post => post.uid === uid && post.type === authorVideoType &&
          URL.parse(post.url)?.pathname.replace(/\/$/u, "") === URL.parse(archive.url)?.pathname)
        return latestOriginalVideo(uid, [same ? { ...archive, id: same.id, avatar: same.avatar } : archive], wall)
      } catch {
        options?.signal?.throwIfAborted()
        // An installation may authorize only the shared dynamics service.
      }
    }
    return latestOriginalVideo(uid, await provider.fetchPosts(uid, { ...options, oldest: wall + 1 }), wall)
  } }
  const dispatch = createSubscriptionDelivery({
    ...delivery, signal: active, providers: { bilibili: source }, now, sendPace: [10_000, 20_000],
    config: {
      async routes() { return (await settings()).enable ? store.routes() : [] },
      async settings() {
        return { ...await settings(), enable: true, cron: "*/3 * * * *",
          horizon: 4102444800, forwards: false, mergeForward: false, liveAtAll: false }
      },
    },
    accepts: (route, post) => isAuthorRoute(route) && post.createdAt > route.createdAfter,
    async onDelivery(route, post, _state, signal) {
      if (isAuthorRoute(route)) await store.checkpoint(route, post.createdAt, signal)
    },
  })

  const fallback: MessageFallback = async (message, context) => {
    if (context.message_type !== "group" || context.isDelegated || active.aborted) return
    const command = parse(message, context)
    if (!command) return
    const chat = numericId(context.group_id)
    const bot = numericId(context.self_id)
    if (!chat || !bot) return
    const group = { chat, bot }
    const wall = Math.floor(now() / 1000)
    try {
      if (command.kind === "list") {
        const routes = (await store.routes()).filter(route => route.chat === chat && route.bot === bot)
        return routes.length ? ["本群 B 站投稿订阅", ...routes.map(row => `${row.name} · UID ${row.uid}`)].join("\n")
          : "本群没有 B 站投稿订阅。"
      }
      if (!context.member?.is_admin && !context.member?.is_owner &&
          !(typeof context.user_id === "number" && context.isBotMaster?.(context.user_id))) {
        return "只有本群群主、管理员或当前机器人主人可以修改投稿订阅。"
      }
      const signal = context.groupActivitySignal ? AbortSignal.any([active, context.groupActivitySignal]) : active
      if (command.kind === "migrate") {
        if (command.bot && command.bot !== bot) return
        if (!command.bot && !(typeof context.user_id === "number" && context.isBotMaster?.(context.user_id))) {
          return "请在指令末尾明确填写接收旧订阅的机器人 QQ。"
        }
        const legacy = await readLegacyAuthorVideos(dirname(directory), chat, wall, signal)
        if (!legacy.length) return "未发现当前群的旧 B 站投稿订阅。"
        const count = await store.add(group, legacy, signal)
        return `已为当前群迁移 ${count} 条 B 站投稿订阅，已存在的记录保留。`
      }
      const uid = command.uid || numericId(await quotedAuthor?.(context))
      if (!uid) return "请提供作者 UID 或引用可识别的 B 站视频。"
      if (command.kind === "remove") {
        return await store.remove(group, uid, signal) ? `已取消 UID ${uid} 的 B 站投稿订阅。` : "本群没有订阅该作者的投稿。"
      }
      const profile = await provider.profile(uid, { signal, allowUnverified: true })
      if (!profile || profile.uid !== uid) return "未找到这位 B 站作者。"
      const name = profile.name.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 80) || uid
      const count = await store.add(group, [{ uid, name, createdAfter: wall }], signal)
      return count ? `已订阅 ${name}（UID ${uid}）的新投稿。` : `本群已经订阅 ${name} 的投稿。`
    } catch {
      if (!active.aborted) return "B 站投稿订阅暂时无法处理，请稍后重试。"
    }
  }

  return { fallback, features(context: MessageFallbackContext) {
    return context.message_type === "group" && parse(context.normalizedMessage, context) ? feature : []
  }, run: () => dispatch.run("bilibili", true), start: dispatch.start, async dispose() {
    destroyed.abort()
    await dispatch.dispose()
  } }
}

function parse(text: string, context: Pick<MessageFallbackContext, "reply_id">) {
  const command = text.trim()
  if (list.test(command)) return { kind: "list" } as const
  const legacy = migration.exec(command)
  if (legacy) return { kind: "migrate", bot: legacy[1] } as const
  const match = edit.exec(command) ?? legacyEdit.exec(command)
  if (!match || !match[2] && context.reply_id === undefined) return
  return { kind: remove.test(match[1]!) ? "remove" : "add", uid: match[2] } as const
}
