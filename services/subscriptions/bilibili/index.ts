import { articleContent } from "./article.ts"
import { publicCount } from "../profile.ts"
import { ExpiredSubscriptionSession, readWithSubscriptionSession, type SubscriptionSession } from "../session.ts"
import type { DynamicActivity, DynamicPost, SubscriptionProfile, SubscriptionProvider } from "../types.ts"
import type { BiliSharedSession } from "./shared.ts"

interface LiveInfo {
  title?: unknown
  link?: unknown
  jump_url?: unknown
  cover?: unknown
  parent_area_name?: unknown
  area_name?: unknown
  live_start_time?: unknown
  watched_show?: { num?: unknown }
}

interface BiliDynamic {
  id_str?: unknown
  type?: unknown
  orig?: unknown
  modules?: {
    module_author?: { mid?: unknown; name?: unknown; pub_ts?: unknown; face?: unknown }
    module_stat?: { like?: { count?: unknown }; comment?: { count?: unknown }; forward?: { count?: unknown } }
    module_dynamic?: {
      desc?: { title?: unknown; text?: unknown; rich_text_nodes?: unknown }
      major?: {
        opus?: {
          title?: unknown; summary?: { rich_text_nodes?: unknown; text?: unknown }; pics?: unknown; jump_url?: unknown
        }
        draw?: { items?: unknown }
        archive?: { title?: unknown; desc?: unknown; jump_url?: unknown; cover?: unknown; stat?: { play?: unknown; danmaku?: unknown } }
        article?: { title?: unknown; desc?: unknown; jump_url?: unknown; covers?: unknown }
        live_rcmd?: { content?: unknown }
        live?: LiveInfo
      }
    }
  }
}

interface BiliPublicData {
  item?: unknown
  items?: unknown
  card?: {
    mid?: unknown; name?: unknown; sign?: unknown; sex?: unknown; level_info?: { current_level?: unknown }
    fans?: unknown; attention?: unknown; friend?: unknown
    live_room?: { roomid?: unknown; liveStatus?: unknown; title?: unknown; watched_show?: { num?: unknown } }
  }
  follower?: unknown
  result?: unknown
}

interface BiliProviderOptions {
  fetch?: (url: URL, options?: RequestInit) => Promise<Response>
  session?: SubscriptionSession
  shared?: Pick<BiliSharedSession, "fetchPosts">
}

// Dynamic fields and type mapping adapted from Yuki BiliQuery (MIT).
const dynamicRoot = "https://m.bilibili.com/dynamic/"
const apiRoot = "https://api.bilibili.com"
const headers = { "User-Agent": "Mozilla/5.0", Referer: "https://www.bilibili.com/" }

class PublicAccessDenied extends Error {}

export const biliTypes = Object.freeze({
  DYNAMIC_TYPE_AV: "视频", DYNAMIC_TYPE_WORD: "图文", DYNAMIC_TYPE_DRAW: "图文",
  DYNAMIC_TYPE_ARTICLE: "文章", DYNAMIC_TYPE_FORWARD: "转发", DYNAMIC_TYPE_LIVE_RCMD: "直播",
})

function accountId(value: unknown) {
  const id = String(value ?? "")
  return /^\d{1,22}$/u.test(id) && !/^0+$/u.test(id) ? id : undefined
}

function biliUrl(value: unknown, domains: string[]) {
  if (typeof value !== "string" || value.length > 4096) return
  const url = URL.parse(value.startsWith("//") ? "https:" + value : value)
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port ||
      !domains.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain))) return
  url.protocol = "https:"
  return url.href
}

const page = (value: unknown) => biliUrl(value, ["bilibili.com", "b23.tv"])
const picture = (value: unknown) => biliUrl(value, ["hdslb.com", "biliimg.com"])

function richText(nodes: unknown) {
  if (typeof nodes === "string") return nodes
  return Array.isArray(nodes) ? nodes.map((node: { text?: unknown } | undefined) => node?.text ?? "").join("") : ""
}

function liveInfo(content: unknown): LiveInfo | undefined {
  if (typeof content !== "string") return
  try {
    const parsed: { live_play_info?: LiveInfo } | null = JSON.parse(content)
    return parsed?.live_play_info
  }
  catch { return }
}

function interactions(dynamicStats: NonNullable<BiliDynamic["modules"]>["module_stat"]): DynamicActivity {
  return {
    likes: publicCount(dynamicStats?.like?.count),
    comments: publicCount(dynamicStats?.comment?.count),
    shares: publicCount(dynamicStats?.forward?.count),
  }
}

function streamActivity(live: LiveInfo | undefined, roomUrl: string | undefined): DynamicActivity {
  const parent = typeof live?.parent_area_name === "string" ? live.parent_area_name.trim().slice(0, 80) : ""
  const child = typeof live?.area_name === "string" ? live.area_name.trim().slice(0, 80) : ""
  const value = live?.live_start_time
  const start = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value
  return {
    area: parent && child && parent !== child ? `${parent} (${child})` : child || parent,
    openedAt: typeof start === "number" && Number.isSafeInteger(start) && start > 0 && Number.isFinite(new Date(start * 1000).getTime()) ? start : undefined,
    viewers: publicCount(live?.watched_show?.num),
    roomUrl: roomUrl && URL.parse(roomUrl)?.hostname === "live.bilibili.com" ? roomUrl : undefined,
  }
}

function profileLive(value: NonNullable<BiliPublicData["card"]>["live_room"]): SubscriptionProfile["live"] {
  if (!value) return
  const roomId = accountId(value.roomid)
  if (!roomId) return
  const status = value.liveStatus
  return {
    roomId,
    title: typeof value.title === "string" ? value.title.slice(0, 120).toWellFormed() : undefined,
    status: status === 1 || status === "1" ? "直播中" : status === 0 || status === "0" ? "未开播" : undefined,
    viewers: publicCount(value.watched_show?.num),
  }
}

export function normalizeBiliDynamic(input: unknown, expectedUid?: string, allowForward = true): DynamicPost | undefined {
  const raw = input as BiliDynamic | undefined
  const author = raw?.modules?.module_author ?? {}
  const uid = accountId(author.mid)
  const id = accountId(raw?.id_str)
  const createdAt = Number(author.pub_ts)
  const type = raw?.type
  if (!id || !uid || expectedUid && uid !== expectedUid || typeof type !== "string" || !Object.hasOwn(biliTypes,type) ||
      !Number.isSafeInteger(createdAt) || createdAt <= 0) return

  const dynamic = raw?.modules?.module_dynamic ?? {}
  const major = dynamic.major ?? {}
  const opus = major.opus
  const legacyTitle = type === "DYNAMIC_TYPE_WORD" || type === "DYNAMIC_TYPE_DRAW" ? dynamic.desc?.title : undefined
  let title = opus?.title ?? legacyTitle
  let content = richText(opus?.summary?.rich_text_nodes ?? opus?.summary?.text ??
    dynamic.desc?.rich_text_nodes ?? dynamic.desc?.text)
  let url = dynamicRoot + id
  const list = opus?.pics ?? major.draw?.items
  let images = Array.isArray(list) ? list.map((item: { url?: unknown; src?: unknown } | undefined) => picture(item?.url ?? item?.src)).filter(value => value !== undefined) : []
  let cover: string | undefined
  let activity = interactions(raw?.modules?.module_stat)
  if (type === "DYNAMIC_TYPE_AV") {
    title = major.archive?.title ?? title
    content = richText(major.archive?.desc) || content
    url = page(major.archive?.jump_url) || url
    cover = picture(major.archive?.cover)
    activity.views = publicCount(major.archive?.stat?.play)
    activity.bullets = publicCount(major.archive?.stat?.danmaku)
  } else if (type === "DYNAMIC_TYPE_ARTICLE") {
    title = major.article?.title ?? title
    content ||= richText(major.article?.desc)
    url = page(opus?.jump_url || major.article?.jump_url) || url
    images = Array.isArray(major.article?.covers) ? major.article.covers.map(picture).filter(value => value !== undefined) : images
  } else if (type === "DYNAMIC_TYPE_LIVE_RCMD") {
    const live = liveInfo(major.live_rcmd?.content)
    title = live?.title ?? major.live?.title ?? title
    const roomUrl = page(live?.link ?? major.live?.jump_url)
    url = roomUrl || url
    cover = picture(live?.cover ?? major.live?.cover)
    activity = streamActivity(live ?? major.live, roomUrl)
  }
  return {
    id, uid, author: typeof author.name === "string" ? author.name : uid, createdAt, type,
    title: typeof title === "string" ? title : "", content, url, images, cover, activity, avatar: picture(author.face),
    forwarded: allowForward && type === "DYNAMIC_TYPE_FORWARD" ? normalizeBiliDynamic(raw?.orig, undefined, false) : undefined,
  }
}

export function createBiliProvider({ fetch: request = globalThis.fetch, session, shared }: BiliProviderOptions = {}): SubscriptionProvider & {
  fetchPost(id: string, signal?: AbortSignal): Promise<DynamicPost | undefined>
} {
  async function get(route: string, query: Record<string, string>, signal?: AbortSignal,
    beforeAnonymous?: (active?: AbortSignal) => Promise<BiliPublicData | undefined>) {
    const url = new URL(route, apiRoot)
    url.search = new URLSearchParams(query).toString()
    const timeout = AbortSignal.timeout(15000)
    return readWithSubscriptionSession(request, session, url, {
      headers, credentials: "omit", redirect: "error", signal: signal ? AbortSignal.any([signal,timeout]) : timeout,
    }, async (response) => {
      if (!response.ok) {
        await response.body?.cancel()
        const message = "B 站公开接口 HTTP " + response.status
        if (response.status === 401) throw new ExpiredSubscriptionSession(message)
        if (response.status === 403 || response.status === 412) throw new PublicAccessDenied(message)
        throw new Error(message)
      }
      const json = await response.json() as { code?: unknown; data?: BiliPublicData }
      if (json.code === -404) return
      if (json.code === -101) throw new ExpiredSubscriptionSession("B 站登录已失效")
      if (json.code === -352 || json.code === -403) throw new PublicAccessDenied("B 站公开接口返回 " + json.code)
      if (json.code !== 0 || !json.data) throw new Error("B 站公开接口返回 " + String(json.code))
      return json.data
    }, beforeAnonymous)
  }

  async function expand(post: DynamicPost, signal?: AbortSignal) {
    if (post.type !== "DYNAMIC_TYPE_ARTICLE" || post.content.length < 480) return post
    const url=URL.parse(post.url)
    if (url?.hostname !== "www.bilibili.com" || !/^\/(?:read\/cv|opus\/)\d+\/?$/u.test(url.pathname)) return post
    try {
      const timeout=AbortSignal.timeout(12000)
      const response=await request(url,{headers,credentials:"omit",redirect:"error",
        signal:signal?AbortSignal.any([signal,timeout]):timeout})
      const max=4*1024*1024
      if (!response.ok || !response.body || Number(response.headers.get("content-length"))>max) {
        await response.body?.cancel()
        return post
      }
      const chunks: Uint8Array[] = []
      let size=0
      for await (const part of response.body) {
        size+=part.byteLength
        if(size>max)return post
        chunks.push(part)
      }
      const article=articleContent(Buffer.concat(chunks,size).toString("utf8"))
      if (!article || article.content.length <= post.content.length) return post
      return {...post,content:article.content,images:[...new Set([...article.images.map(picture).filter(value => value !== undefined),...post.images])]}
    } catch {
      signal?.throwIfAborted()
      return post
    }
  }

  return {
    id: "bilibili", label: "B站", typeNames: biliTypes,
    async fetchPost(id, signal) {
      if (!accountId(id)) return
      const data = await get("/x/polymer/web-dynamic/v1/detail", { id, platform: "web", features: "itemOpusStyle,opusBigCover,ugcDelete" }, signal)
      const post = normalizeBiliDynamic(data?.item)
      if (post?.id === id) return expand(post, signal)
    },
    async fetchPosts(uid, {signal,oldest=0} = {}) {
      if (!accountId(uid)) return []
      const data = await get("/x/polymer/web-dynamic/v1/feed/space", {host_mid:uid, offset:""}, signal,
        shared && (active => shared.fetchPosts(uid, active)))
      if (!data || !Array.isArray(data.items)) throw new Error("B 站动态列表结构无效")
      const posts=data.items.map(raw=>normalizeBiliDynamic(raw,uid)).filter(value => value !== undefined)
      for (const [index,post] of posts.entries()) if (post.createdAt>=oldest) posts[index]=await expand(post,signal)
      return posts
    },
    async profile(uid, {signal,allowUnverified=false} = {}) {
      if (!accountId(uid)) return
      let data
      try {
        data = await get("/x/web-interface/card", {mid:uid}, signal)
      } catch (error) {
        if (allowUnverified && !signal?.aborted && error instanceof PublicAccessDenied) {
          return {uid, name:uid, verificationFailure:error.message}
        }
        throw error
      }
      const card = data?.card
      if (!card || accountId(card.mid) !== uid || typeof card.name !== "string" || !card.name.trim()) return
      return {
        uid, name:card.name.slice(0,80).toWellFormed(), summary:typeof card.sign === "string" ? card.sign : "",
        gender:card.sex === "男" || card.sex === "女" || card.sex === "保密" ? card.sex : undefined,
        level:publicCount(card.level_info?.current_level), followers:publicCount(data?.follower) ?? publicCount(card.fans),
        following:publicCount(card.attention) ?? publicCount(card.friend), live:profileLive(card.live_room),
      }
    },
    async search(keyword, {signal} = {}) {
      const data = await get("/x/web-interface/search/type", {keyword,search_type:"bili_user",page:"1",order:"totalrank"}, signal)
      if (!Array.isArray(data?.result)) return []
      return data.result.flatMap((item: { mid?: unknown; uname?: unknown; usign?: unknown; fans?: unknown } | undefined) => {
        const uid = accountId(item?.mid)
        const name = typeof item?.uname === "string" ? item.uname.replace(/<[^>]+>/g, "").slice(0,80).toWellFormed() : ""
        return uid && name ? [{ uid, name, summary: typeof item?.usign === "string" ? item.usign : "", followers: publicCount(item?.fans) }] : []
      })
    },
  }
}
