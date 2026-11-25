import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { dirname } from "node:path"
import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import { isBiliVideoPage } from "../bilibili/service.ts"
import { numericId, type SubscriptionRoute, type SubscriptionSettings } from "./config.ts"
import { createSubscriptionDelivery } from "./delivery.ts"
import type { DynamicPost, LockSubscriptionFile, SubscriptionProvider } from "./types.ts"
import { authorVideoType, createAuthorVideoStore, readLegacyAuthorVideos, type AuthorRoute } from "./xhh-author-store.ts"

const platform = $t("services.subscriptions.xhh-author-command.text_fc35ec66d4")
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
        return routes.length ? [$t("services.subscriptions.xhh-author-command.text_df70bcd9fb"), ...routes.map(row => `${row.name} · UID ${row.uid}`)].join("\n")
          : $t("services.subscriptions.xhh-author-command.text_5f28895039")
      }
      if (!context.member?.is_admin && !context.member?.is_owner &&
          !(typeof context.user_id === "number" && context.isBotMaster?.(context.user_id))) {
        return $t("services.subscriptions.xhh-author-command.text_71e0fa0875")
      }
      const signal = context.groupActivitySignal ? AbortSignal.any([active, context.groupActivitySignal]) : active
      if (command.kind === "migrate") {
        if (command.bot && command.bot !== bot) return
        if (!command.bot && !(typeof context.user_id === "number" && context.isBotMaster?.(context.user_id))) {
          return $t("services.subscriptions.xhh-author-command.text_a6a196efdc")
        }
        const legacy = await readLegacyAuthorVideos(dirname(directory), chat, wall, signal)
        if (!legacy.length) return $t("services.subscriptions.xhh-author-command.text_a9c945b62e")
        const count = await store.add(group, legacy, signal)
        return $t("services.subscriptions.xhh-author-command.text_21accfecd3", { "count": count })
      }
      const uid = command.uid || numericId(await quotedAuthor?.(context))
      if (!uid) return $t("services.subscriptions.xhh-author-command.text_5e712e6ce4")
      if (command.kind === "remove") {
        return await store.remove(group, uid, signal) ? $t("services.subscriptions.xhh-author-command.text_fbc4a4e39b", { "uid": uid }) : $t("services.subscriptions.xhh-author-command.text_b2cae40c95")
      }
      const profile = await provider.profile(uid, { signal, allowUnverified: true })
      if (!profile || profile.uid !== uid) return $t("services.subscriptions.xhh-author-command.text_68262f0b55")
      const name = profile.name.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 80) || uid
      const count = await store.add(group, [{ uid, name, createdAfter: wall }], signal)
      return count ? $t("services.subscriptions.xhh-author-command.text_a9b832edb7", { "name": name, "uid": uid }) : $t("services.subscriptions.xhh-author-command.text_82d785f89f", { "name": name })
    } catch {
      if (!active.aborted) return $t("services.subscriptions.xhh-author-command.text_cff7c2e646")
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
