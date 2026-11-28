import { createTranslator as createTextTranslator } from "../../../../../packages/i18n/index.ts";
import messageCatalog from "../../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { readPublicResponse } from "../../public-read.ts"
// Source format: snowtafir/yuki-plugin main3, b1d8fecf41d03f92746bb2404b0b0381a24103a5 (MIT).
import { ExpiredSubscriptionSession, readWithSubscriptionSession, type SubscriptionSession } from "../session.ts"
import { withWeiboVisitorRecovery } from "./visitor.ts"
import type { DynamicPost, SubscriptionProfile, SubscriptionProvider } from "../types.ts"

interface WeiboUser {
  id?: unknown
  idstr?: unknown
  screen_name?: unknown
  profile_image_url?: unknown
  avatar_large?: unknown
  description?: unknown
  gender?: unknown
  verified_reason?: unknown
  verified?: unknown
  followers_count?: unknown
  followers_count_str?: unknown
  follow_count?: unknown
}

interface WeiboPost {
  mid?: unknown
  idstr?: unknown
  id?: unknown
  bid?: unknown
  created_at?: unknown
  longText?: { longTextContent?: unknown }
  text?: unknown
  user?: WeiboUser
  visible?: { type?: unknown }
  pics?: unknown
  pic_num?: unknown
  isLongText?: unknown
  page_info?: { page_pic?: { url?: unknown }; title?: unknown; type?: unknown }
  retweeted_status?: WeiboPost
  attitudes_count?: unknown
  comments_count?: unknown
  reposts_count?: unknown
}

interface WeiboCard {
  card_type?: unknown
  mblog?: WeiboPost
  card_group?: unknown
  users?: unknown
  user?: WeiboUser
}

interface WeiboFeed {
  cards?: unknown
  userInfo?: WeiboUser
}

interface WeiboProviderOptions {
  fetch?: (url: URL, options?: RequestInit) => Promise<Response>
  session?: SubscriptionSession
}

interface DetailNeeds {
  text: boolean
  images: boolean
}
import { load } from "cheerio"
import { publicCount } from "../profile.ts"

const entrypoint = "https://m.weibo.cn/api/container/getIndex"
const detailRoot = "https://m.weibo.cn/detail/"
const maximumPictures = 30
const emptyMessages = new Set(["这里还没有内容", "这里还没有内容哦", "用户不存在", "该用户不存在"])
export const weiboTypes = Object.freeze({
  DYNAMIC_TYPE_AV: "视频", DYNAMIC_TYPE_WORD: "图文", DYNAMIC_TYPE_DRAW: "图文",
  DYNAMIC_TYPE_ARTICLE: "文章", DYNAMIC_TYPE_FORWARD: "转发",
})
export const weiboTypesLabels = Object.freeze({
  DYNAMIC_TYPE_AV: $t("services.subscriptions.weibo.index.text_c20f7618d3"), DYNAMIC_TYPE_WORD: $t("services.subscriptions.weibo.index.text_fd7137eb5c"), DYNAMIC_TYPE_DRAW: $t("services.subscriptions.weibo.index.text_fd7137eb5c"),
  DYNAMIC_TYPE_ARTICLE: $t("services.subscriptions.weibo.index.text_7d5a89f6b1"), DYNAMIC_TYPE_FORWARD: $t("services.subscriptions.weibo.index.text_02107ba378"),
})

function record(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function decimalId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value)
  return typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value) ? value : undefined
}

function clean(text: unknown, limit: number) {
  if (typeof text !== "string") return ""
  return text.replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .trim().slice(0, limit).toWellFormed()
}

function contentOf(post: WeiboPost) {
  return textOf(post.longText?.longTextContent || post.text, 131_072, 16_000)
}

function textOf(html: unknown, inputLimit: number, outputLimit: number) {
  if (typeof html !== "string") return ""
  const $ = load(html.slice(0, inputLimit), {}, false)
  $("script, style, template, noscript, iframe").remove()
  $("br").replaceWith(() => "\n")
  $("p, div").each((_, node) => { $(node).append("\n") })
  $("img").replaceWith((_, node) => $("<span>").text(clean($(node).attr("alt"), 80)))
  return clean($.root().text(), outputLimit)
}

function imageUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 4096) return
  const url = URL.parse(value.startsWith("//") ? `https:${value}` : value)
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port ||
      !/(?:^|\.)sinaimg\.cn$/iu.test(url.hostname)) return
  url.protocol = "https:"
  return url.href
}

function pictures(post: WeiboPost) {
  const source = Array.isArray(post.pics) ? post.pics : []
  return [...new Set(source.slice(0, maximumPictures).map((pic: { large?: { url?: unknown }; url?: unknown; bmiddle?: { url?: unknown } } | undefined) =>
    imageUrl(pic?.large?.url) ?? imageUrl(pic?.url) ?? imageUrl(pic?.bmiddle?.url)).filter(value => value !== undefined))]
}

function profileOf(value: WeiboUser | undefined): SubscriptionProfile | undefined {
  if (!value) return
  const uid = decimalId(value.idstr) ?? decimalId(value.id)
  const name = clean(value?.screen_name, 80)
  if (!uid || !name) return
  return {
    uid, name, summary: clean(value.description, 250) || undefined,
    gender: value.gender === "f" ? $t("services.subscriptions.weibo.index.text_0ab4610b92") : value.gender === "m" ? $t("services.subscriptions.weibo.index.text_4e79758a99") : undefined,
    verification: clean(value.verified_reason, 160) || (value.verified === false ? $t("services.subscriptions.weibo.index.text_d9c133f233") : undefined),
    followers: publicCount(value.followers_count) ?? publicCount(value.followers_count_str),
    following: publicCount(value.follow_count),
  }
}

function publishedAt(value: unknown) {
  const parsed = typeof value === "string" ? Math.floor(Date.parse(value) / 1000) : value
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function postId(post: WeiboPost | undefined) {
  // The legacy polling receipt uses mid, then id. idstr is the lossless spelling of numeric id.
  return decimalId(post?.mid) ?? decimalId(post?.idstr) ?? decimalId(post?.id)
}

function authorId(post: WeiboPost | undefined) {
  return decimalId(post?.user?.idstr) ?? decimalId(post?.user?.id)
}

function postOf(post: WeiboPost | undefined, depth = 0): DynamicPost | undefined {
  if (!post || !record(post)) return
  const id = postId(post)
  const uid = authorId(post)
  const createdAt = publishedAt(post.created_at)
  if (!id || !uid || !createdAt) return
  const media = record(post.page_info) ? post.page_info : undefined
  const images = pictures(post)
  const cover = imageUrl(media?.page_pic?.url)
  const forwarded = depth < 2 ? postOf(post.retweeted_status, depth + 1) : undefined
  const content = contentOf(post)
  if (!content && !images.length && !cover && !forwarded && !record(post.retweeted_status)) return
  const type = record(post.retweeted_status) ? "DYNAMIC_TYPE_FORWARD"
    : media?.type === "video" ? "DYNAMIC_TYPE_AV"
    : Array.isArray(post.pics) ? "DYNAMIC_TYPE_DRAW"
    : "DYNAMIC_TYPE_ARTICLE"
  const bid = typeof post.bid === "string" && /^[A-Za-z0-9]{1,24}$/u.test(post.bid) ? post.bid : undefined
  return {
    id, uid, author: clean(post.user?.screen_name, 80) || uid, createdAt, type,
    title: clean(media?.title, 160) || undefined, content,
    url: bid ? `https://weibo.com/${uid}/${bid}` : detailRoot + id,
    activity: { likes: publicCount(post.attitudes_count), comments: publicCount(post.comments_count), shares: publicCount(post.reposts_count) },
    images, forwarded, cover, avatar: imageUrl(post.user?.profile_image_url ?? post.user?.avatar_large),
  }
}

export interface WeiboPostIdentity {
  readonly id: string
  readonly uid?: string
}

function detailNeeds(raw: WeiboPost | undefined, post: DynamicPost | undefined): DetailNeeds | undefined {
  if (!raw || !post) return
  const inline = raw.longText?.longTextContent
  const text = (raw.isLongText === true || raw.isLongText === 1) && !(typeof inline === "string" && inline.trim())
  const count = Number(raw.pic_num)
  const images = Number.isSafeInteger(count) && count > 9 && post.images.length < Math.min(count, maximumPictures)
  if (text || images) return { text, images }
}

function samePost(raw: WeiboPost | undefined, post: DynamicPost) {
  return postId(raw) === post.id && authorId(raw) === post.uid
}

function detailStatus(html: string, matches: (post: WeiboPost) => boolean) {
  const $ = load(html)
  for (const script of $("script").toArray()) {
    const match = $(script).text().match(/"status"\s*:\s*(\{[\s\S]*?\})\s*,\s*"call"\s*:/u)
    if (!match?.[1]) continue
    try {
      const raw: WeiboPost = JSON.parse(match[1])
      if (raw && matches(raw)) return raw
    } catch { /* The detail format is optional. */ }
  }
}

function publicPost(raw: WeiboPost, depth = 0): WeiboPost | undefined {
  const visibility = raw.visible?.type
  if (visibility !== undefined && visibility !== 0 && visibility !== "0") return
  if (!raw.retweeted_status) return raw
  return { ...raw, retweeted_status: depth < 2 ? publicPost(raw.retweeted_status, depth + 1) : undefined }
}

export async function fetchPublicWeiboPost({ id, uid }: WeiboPostIdentity, signal?: AbortSignal,
  request: NonNullable<WeiboProviderOptions["fetch"]> = globalThis.fetch) {
  if (!/^[A-Za-z0-9]{1,24}$/u.test(id) || (uid !== undefined && !decimalId(uid))) return
  const timeout = AbortSignal.timeout(10_000)
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
  const matches = (post: WeiboPost) => (!uid || authorId(post) === uid) && (postId(post) === id || post.bid === id)
  const page = new URL(detailRoot + id)
  const api = new URL("https://m.weibo.cn/statuses/show")
  api.searchParams.set("id", id)
  const options: RequestInit = { method: "GET", credentials: "omit", redirect: "manual", signal: deadline }
  for (const [endpoint, json] of [[page, false], [api, true]] as const) {
    try {
      deadline.throwIfAborted()
      const response = await readPublicResponse((target, init) => request(new URL(target), init), endpoint, { ...options, headers: json
        ? { Accept: "application/json", Referer: page.href, "X-Requested-With": "XMLHttpRequest", "User-Agent": "Lotus-Yunzai" }
        : { Accept: "text/html", "User-Agent": "Lotus-Yunzai" } }, json ? 2 : 1)
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        continue
      }
      const body = await readText(response)
      deadline.throwIfAborted()
      const envelope = json ? JSON.parse(body) as { ok?: unknown; data?: WeiboPost } | null : null
      const raw = json ? envelope?.ok === 1 && envelope.data && matches(envelope.data) ? envelope.data : undefined
        : detailStatus(body, matches)
      const post = postOf(raw && publicPost(raw))
      if (post) return post
    } catch {
      signal?.throwIfAborted()
    }
  }
}

interface WeiboCommentPayload {
  id?: unknown
  idstr?: unknown
  user?: WeiboUser
  text?: unknown
  like_count?: unknown
  created_at?: unknown
  source?: unknown
  status?: WeiboPost
}

export interface WeiboPublicComment {
  readonly author: string
  readonly text: string
  readonly likes?: string
  readonly createdAt?: number
  readonly source?: string
}

export async function fetchPublicWeiboComments(mid: string, signal?: AbortSignal,
  request: NonNullable<WeiboProviderOptions["fetch"]> = globalThis.fetch): Promise<readonly WeiboPublicComment[]> {
  if (!decimalId(mid)) return []
  const api = new URL("https://m.weibo.cn/comments/hotflow")
  api.search = new URLSearchParams({ id: mid, mid, max_id_type: "0" }).toString()
  const timeout = AbortSignal.timeout(5_000)
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    deadline.throwIfAborted()
    const response = await readPublicResponse((target, init) => request(new URL(target), init), api, { method: "GET", credentials: "omit", redirect: "manual", signal: deadline,
      headers: { Accept: "application/json", Referer: detailRoot + mid, "X-Requested-With": "XMLHttpRequest", "User-Agent": "Lotus-Yunzai" } })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      return []
    }
    const envelope: { ok?: unknown; data?: { data?: unknown; status?: WeiboPost } } | null =
      JSON.parse(await readText(response, 512 * 1024))
    deadline.throwIfAborted()
    const parent = postId(envelope?.data?.status)
    if (envelope?.ok !== 1 || !Array.isArray(envelope.data?.data) || (parent && parent !== mid)) return []
    const seen = new Set<string>()
    const comments: WeiboPublicComment[] = []
    for (const value of envelope.data.data) {
      if (!record(value)) continue
      const row = value as WeiboCommentPayload
      const id = decimalId(row.idstr) ?? decimalId(row.id)
      const status = postId(row.status)
      if (!id || seen.has(id) || (status && status !== mid)) continue
      const author = clean(row.user?.screen_name, 80)
      const text = textOf(row.text, 16_384, 600).replace(/\n{2,}/gu, "\n").split("\n")
      const content = text.length > 6 ? text.slice(0, 6).join("\n") + "…" : text.join("\n")
      if (!author || !content) continue
      const createdAt = publishedAt(row.created_at)
      seen.add(id)
      comments.push({ author, text: content, likes: publicCount(row.like_count),
        createdAt: createdAt && createdAt <= 8_640_000_000_000 ? createdAt : undefined,
        source: textOf(row.source, 1024, 80) || undefined })
      if (comments.length === 20) break
    }
    return comments
  } catch {
    signal?.throwIfAborted()
    return []
  }
}

function completePost(post: DynamicPost, raw: WeiboPost | undefined, needs: DetailNeeds | undefined) {
  if (!raw || !needs || !samePost(raw, post)) return post
  const content = needs.text ? contentOf(raw) : ""
  const images = needs.images ? pictures(raw) : []
  return {
    ...post,
    content: content.length > post.content.length ? content : post.content,
    images: images.length > post.images.length ? images : post.images,
  }
}

async function readText(response: Response, maxBytes = 4 * 1024 * 1024) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error($t("services.subscriptions.weibo.index.text_40f379a461"))
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let raw = ""
    let bytes = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return raw + decoder.decode()
      bytes += value.byteLength
      if (bytes > maxBytes) throw new Error($t("services.subscriptions.weibo.index.text_4cfeb34dd5"))
      raw += decoder.decode(value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function createWeiboProvider({ fetch = globalThis.fetch, session }: WeiboProviderOptions = {}): SubscriptionProvider {
  const visitorRequest = withWeiboVisitorRecovery(fetch)
  async function get(params: Record<string, string>, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const url = new URL(entrypoint)
    url.search = new URLSearchParams(params).toString()
    const timeout = AbortSignal.timeout(10_000)
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
    const request = async (input: URL, options: RequestInit) => {
      try {
        return await readPublicResponse((target, init) => visitorRequest(new URL(target), init), input, options)
      } catch {
        deadline.throwIfAborted()
        throw new Error($t("services.subscriptions.weibo.index.text_d7afa223fb"))
      }
    }
    return readWithSubscriptionSession(request, session, url, {
      method: "GET", headers: { Accept: "application/json", "User-Agent": "Lotus-Yunzai" },
      credentials: "omit", redirect: "manual", signal: deadline,
    }, async (response) => {
      if (!response.ok) {
        const loginHost = URL.parse(response.headers.get("Location") ?? "")?.hostname
        void response.body?.cancel().catch(() => {})
        if (response.status === 401 || (response.status >= 300 && response.status < 400 && loginHost === "passport.weibo.com")) {
          throw new ExpiredSubscriptionSession($t("services.subscriptions.weibo.index.text_039ade3dc2"))
        }
        throw new Error($t("services.subscriptions.weibo.index.text_dbb3d5fb4f"))
      }
      // Login pages and risk-control responses must remain distinguishable from an empty public feed.
      let envelope: { ok?: unknown; data?: WeiboFeed; msg?: unknown } | undefined
      try {
        envelope = JSON.parse(await readText(response))
      } catch {
        deadline.throwIfAborted()
        throw new Error($t("services.subscriptions.weibo.index.text_ecd1735eb8"))
      }
      deadline.throwIfAborted()
      if (envelope?.ok === 1 && record(envelope.data)) return envelope.data
      if (envelope?.ok === 0 && typeof envelope.msg === "string" && emptyMessages.has(envelope.msg)) return
      if (envelope?.ok === 0 && typeof envelope.msg === "string" && [$t("services.subscriptions.weibo.index.text_6eb1b64e26"), $t("services.subscriptions.weibo.index.text_48144f96c1"), $t("services.subscriptions.weibo.index.text_c1f6583730")].includes(envelope.msg)) {
        throw new ExpiredSubscriptionSession($t("services.subscriptions.weibo.index.text_039ade3dc2"))
      }
      throw new Error($t("services.subscriptions.weibo.index.text_58f4582f6a"))
    })
  }

  async function expand(raw: WeiboPost, post: DynamicPost, deadline: AbortSignal, signal?: AbortSignal) {
    const needs = detailNeeds(raw, post)
    const originalNeeds = detailNeeds(raw.retweeted_status, post.forwarded)
    if ((!needs && !originalNeeds) || deadline.aborted) return post
    try {
      const response = await readPublicResponse((target, init) => fetch(new URL(target), init), new URL(detailRoot + post.id), {
        method: "GET", headers: { Accept: "text/html", "User-Agent": "Lotus-Yunzai" },
        credentials: "omit", redirect: "manual", signal: deadline,
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        return post
      }
      const detail = detailStatus(await readText(response), raw => samePost(raw, post))
      if (!detail) return post
      const completed = completePost(post, detail, needs)
      if (!originalNeeds || !post.forwarded) return completed
      return { ...completed, forwarded: completePost(post.forwarded, detail.retweeted_status, originalNeeds) }
    } catch {
      signal?.throwIfAborted()
      return post
    }
  }

  return {
    id: "weibo", label: $t("services.subscriptions.weibo.index.text_0fc69798d8"), typeNames: weiboTypesLabels, commandTypeNames: weiboTypes,
    async fetchPosts(account, { signal, oldest = 0 } = {}) {
      const uid = decimalId(account)
      if (!uid) throw new Error($t("services.subscriptions.weibo.index.text_b966d005fb"))
      const data = await get({ containerid: `107603${uid}` }, signal)
      if (!data) return []
      if (!Array.isArray(data.cards)) throw new Error($t("services.subscriptions.weibo.index.text_438d751d54"))
      const posts = new Map<string, DynamicPost>()
      const detailTimeout = AbortSignal.timeout(5000)
      const deadline = signal ? AbortSignal.any([signal, detailTimeout]) : detailTimeout
      const cards: (WeiboCard | undefined)[] = data.cards
      for (const card of cards.slice(0, 100)) {
        if (card?.card_type !== 9 || !card.mblog) continue
        const post = postOf(card.mblog)
        if (post?.uid !== uid || posts.has(post.id)) continue
        posts.set(post.id, post.createdAt >= oldest ? await expand(card.mblog, post, deadline, signal) : post)
      }
      signal?.throwIfAborted()
      return [...posts.values()]
    },
    async profile(account, { signal } = {}) {
      const uid = decimalId(account)
      if (!uid) throw new Error($t("services.subscriptions.weibo.index.text_b966d005fb"))
      const data = await get({ type: "uid", value: uid, containerid: `100505${uid}` }, signal)
      if (!data) return
      const profile = profileOf(data.userInfo)
      if (!profile || profile.uid !== uid) throw new Error($t("services.subscriptions.weibo.index.text_8955522c44"))
      return profile
    },
    async search(keyword, { signal } = {}) {
      const query = clean(keyword, 80)
      if (!query) return []
      const data = await get({ containerid: "100103", type: "1", q: query, page_type: "searchall" }, signal)
      if (!data) return []
      if (!Array.isArray(data.cards)) throw new Error($t("services.subscriptions.weibo.index.text_33c802a122"))
      const profiles = new Map<string, SubscriptionProfile>()
      const cards: (WeiboCard | undefined)[] = data.cards
      for (const card of cards.slice(0, 30)) {
        if (!Array.isArray(card?.card_group)) continue
        const group: (WeiboCard | undefined)[] = card.card_group
        for (const item of group.slice(0, 30)) {
          if (item?.card_type !== 3 && item?.card_type !== 10) continue
          const users: (WeiboUser | undefined)[] = Array.isArray(item?.users) ? item.users.slice(0, 10) : [item?.user]
          for (const user of users) {
            const profile = profileOf(user)
            if (profile && !profiles.has(profile.uid)) profiles.set(profile.uid, profile)
            if (profiles.size >= 10) return [...profiles.values()]
          }
        }
      }
      return [...profiles.values()]
    },
  }
}
