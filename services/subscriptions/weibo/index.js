// Source format: snowtafir/yuki-plugin main3, b1d8fecf41d03f92746bb2404b0b0381a24103a5 (MIT).
import { load } from "cheerio"
import { publicCount } from "../profile.js"

const entrypoint = "https://m.weibo.cn/api/container/getIndex"
const detailRoot = "https://m.weibo.cn/detail/"
const maximumPictures = 30
const emptyMessages = new Set(["这里还没有内容", "这里还没有内容哦", "用户不存在", "该用户不存在"])
const typeNames = Object.freeze({
  DYNAMIC_TYPE_AV: "视频", DYNAMIC_TYPE_WORD: "图文", DYNAMIC_TYPE_DRAW: "图文",
  DYNAMIC_TYPE_ARTICLE: "文章", DYNAMIC_TYPE_FORWARD: "转发",
})

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function decimalId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value)
  return typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value) ? value : undefined
}

function clean(text, limit) {
  if (typeof text !== "string") return ""
  return text.replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .trim().slice(0, limit).toWellFormed()
}

function contentOf(post) {
  const html = post.longText?.longTextContent || post.text
  if (typeof html !== "string") return ""
  const $ = load(html.slice(0, 131_072), {}, false)
  $("script, style, template, noscript, iframe").remove()
  $("br").replaceWith(() => "\n")
  $("p, div").each((_, node) => { $(node).append("\n") })
  $("img").replaceWith((_, node) => $("<span>").text(clean($(node).attr("alt"), 80)))
  return clean($.root().text(), 16_000)
}

function imageUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return
  const url = URL.parse(value.startsWith("//") ? `https:${value}` : value)
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port ||
      !/(?:^|\.)sinaimg\.cn$/iu.test(url.hostname)) return
  url.protocol = "https:"
  return url.href
}

function pictures(post) {
  const source = Array.isArray(post.pics) ? post.pics : []
  return [...new Set(source.slice(0, maximumPictures).map((pic) =>
    imageUrl(pic?.large?.url) ?? imageUrl(pic?.url) ?? imageUrl(pic?.bmiddle?.url)).filter(Boolean))]
}

function profileOf(value) {
  const uid = decimalId(value?.idstr) ?? decimalId(value?.id)
  const name = clean(value?.screen_name, 80)
  if (!uid || !name) return
  return {
    uid, name, summary: clean(value.description, 250) || undefined,
    gender: value.gender === "f" ? "女" : value.gender === "m" ? "男" : undefined,
    verification: clean(value.verified_reason, 160) || (value.verified === false ? "未认证" : undefined),
    followers: publicCount(value.followers_count) ?? publicCount(value.followers_count_str),
    following: publicCount(value.follow_count),
  }
}

function publishedAt(value) {
  const parsed = typeof value === "string" ? Math.floor(Date.parse(value) / 1000) : value
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function postId(post) {
  // The legacy polling receipt uses mid, then id. idstr is the lossless spelling of numeric id.
  return decimalId(post?.mid) ?? decimalId(post?.idstr) ?? decimalId(post?.id)
}

function authorId(post) {
  return decimalId(post?.user?.idstr) ?? decimalId(post?.user?.id)
}

function postOf(post, depth = 0) {
  if (!record(post)) return
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

function detailNeeds(raw, post) {
  if (!post) return
  const inline = raw.longText?.longTextContent
  const text = (raw.isLongText === true || raw.isLongText === 1) && !(typeof inline === "string" && inline.trim())
  const count = Number(raw.pic_num)
  const images = Number.isSafeInteger(count) && count > 9 && post.images.length < Math.min(count, maximumPictures)
  if (text || images) return { text, images }
}

function samePost(raw, post) {
  return postId(raw) === post.id && authorId(raw) === post.uid
}

function detailStatus(html, post) {
  const $ = load(html)
  for (const script of $("script").toArray()) {
    const match = $(script).text().match(/"status"\s*:\s*(\{[\s\S]*?\})\s*,\s*"call"\s*:/u)
    if (!match) continue
    try {
      const raw = JSON.parse(match[1])
      if (samePost(raw, post)) return raw
    } catch { /* The detail format is optional. */ }
  }
}

function completePost(post, raw, needs) {
  if (!needs || !samePost(raw, post)) return post
  const content = needs.text ? contentOf(raw) : ""
  const images = needs.images ? pictures(raw) : []
  return {
    ...post,
    content: content.length > post.content.length ? content : post.content,
    images: images.length > post.images.length ? images : post.images,
  }
}

async function readText(response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("微博接口没有返回内容。")
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let raw = ""
    let bytes = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return raw + decoder.decode()
      bytes += value.byteLength
      if (bytes > 4 * 1024 * 1024) throw new Error("微博公开接口响应过大。")
      raw += decoder.decode(value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function createWeiboProvider({ fetch = globalThis.fetch } = {}) {
  async function get(params, signal) {
    signal?.throwIfAborted()
    const url = new URL(entrypoint)
    url.search = new URLSearchParams(params).toString()
    const timeout = AbortSignal.timeout(10_000)
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response
    try {
      response = await fetch(url, {
        method: "GET", headers: { Accept: "application/json", "User-Agent": "Lotus-Yunzai" },
        credentials: "omit", redirect: "manual", signal: deadline,
      })
    } catch {
      deadline.throwIfAborted()
      throw new Error("无法读取微博公开数据。")
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new Error("微博公开接口拒绝访问或暂不可用。")
    }
    // Login pages and risk-control responses must remain distinguishable from an empty public feed.
    let envelope
    try {
      envelope = JSON.parse(await readText(response))
    } catch {
      deadline.throwIfAborted()
      throw new Error("微博公开接口未返回可读的数据。")
    }
    deadline.throwIfAborted()
    if (envelope?.ok === 1 && record(envelope.data)) return envelope.data
    if (envelope?.ok === 0 && emptyMessages.has(envelope.msg)) return
    throw new Error("微博公开数据不可用。")
  }

  async function expand(raw, post, deadline, signal) {
    const needs = detailNeeds(raw, post)
    const originalNeeds = detailNeeds(raw.retweeted_status, post.forwarded)
    if ((!needs && !originalNeeds) || deadline.aborted) return post
    try {
      const response = await fetch(new URL(detailRoot + post.id), {
        method: "GET", headers: { Accept: "text/html", "User-Agent": "Lotus-Yunzai" },
        credentials: "omit", redirect: "manual", signal: deadline,
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        return post
      }
      const detail = detailStatus(await readText(response), post)
      if (!detail) return post
      const completed = completePost(post, detail, needs)
      if (!originalNeeds) return completed
      return { ...completed, forwarded: completePost(post.forwarded, detail.retweeted_status, originalNeeds) }
    } catch {
      signal?.throwIfAborted()
      return post
    }
  }

  return {
    id: "weibo", label: "微博", typeNames,
    async fetchPosts(uid, { signal, oldest = 0 } = {}) {
      uid = decimalId(uid)
      if (!uid) throw new Error("微博 UID 无效。")
      const data = await get({ containerid: `107603${uid}` }, signal)
      if (!data) return []
      if (!Array.isArray(data.cards)) throw new Error("微博动态列表格式无效。")
      const posts = new Map()
      const detailTimeout = AbortSignal.timeout(5000)
      const deadline = signal ? AbortSignal.any([signal, detailTimeout]) : detailTimeout
      for (const card of data.cards.slice(0, 100)) {
        if (card?.card_type !== 9) continue
        const post = postOf(card.mblog)
        if (post?.uid !== uid || posts.has(post.id)) continue
        posts.set(post.id, post.createdAt >= oldest ? await expand(card.mblog, post, deadline, signal) : post)
      }
      signal?.throwIfAborted()
      return [...posts.values()]
    },
    async profile(uid, { signal } = {}) {
      uid = decimalId(uid)
      if (!uid) throw new Error("微博 UID 无效。")
      const data = await get({ type: "uid", value: uid, containerid: `100505${uid}` }, signal)
      if (!data) return
      const profile = profileOf(data.userInfo)
      if (!profile || profile.uid !== uid) throw new Error("微博主页账号信息不匹配。")
      return profile
    },
    async search(keyword, { signal } = {}) {
      const query = clean(keyword, 80)
      if (!query) return []
      const data = await get({ containerid: "100103", type: "1", q: query, page_type: "searchall" }, signal)
      if (!data) return []
      if (!Array.isArray(data.cards)) throw new Error("微博搜索结果格式无效。")
      const profiles = new Map()
      for (const card of data.cards.slice(0, 30)) {
        if (!Array.isArray(card?.card_group)) continue
        for (const item of card.card_group.slice(0, 30)) {
          if (item?.card_type !== 3 && item?.card_type !== 10) continue
          const users = Array.isArray(item?.users) ? item.users.slice(0, 10) : [item?.user]
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
