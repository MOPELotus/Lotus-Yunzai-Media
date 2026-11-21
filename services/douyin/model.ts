import { load } from "cheerio"
import { DouyinError } from "./http.ts"

export interface MediaSource {
  urls: string[]
  quality?: string
  sizeBytes?: number
  width?: number
  height?: number
  bitrate?: number
  codec?: "h264" | "h265"
  format?: string
}

type ArticleBlock =
  | { type: "text"; text: string }
  | { type: "image"; urls: string[]; caption?: string }

interface MediaItem {
  index: number
  type: "image" | "video" | "live_photo"
  urls: string[]
  sources: MediaSource[]
  width?: number
  height?: number
  caption?: string
}

interface WireAddress {
  uri?: string
  url_list?: unknown
  data_size?: unknown
  width?: unknown
  height?: unknown
}

interface WireVariant {
  play_addr?: WireAddress
  video_extra?: { definition?: string } | string
  gear_name?: string
  bit_rate?: unknown
  is_bytevc1?: number
  h264?: boolean
  format?: string
}

interface WireVideo {
  bit_rate?: WireVariant[]
  play_addr_h264?: WireAddress
  play_addr?: WireAddress
  download_addr?: WireAddress
  origin_cover?: unknown
  cover?: unknown
  duration?: unknown
}

interface WireImage extends WireAddress {
  clip_type?: number
  video?: WireVideo
}

interface ArticleContent {
  markdown?: unknown
  blocks?: unknown
  body?: unknown
  content?: unknown
  head_poster_list?: unknown
}

interface ArticleImages {
  image_list?: Array<{
    markdown_url?: string
    ai_high_image_url?: string
    high_image_url?: string
    origin_image_url?: string
  }>
}

interface ArticleNode {
  url_list?: unknown
  image?: { url_list?: unknown }
  url?: unknown
  src?: unknown
  type?: unknown
  tag?: unknown
  text?: unknown
  children?: unknown
  content?: unknown
  body?: unknown
}

interface WireArticle {
  article_title?: string
  article_content?: ArticleContent | string
  fe_data?: ArticleImages | string
}

export interface AwemeDetail {
  aweme_id?: string | number
  aweme_type?: number
  images?: WireImage[]
  article_info?: WireArticle
  video?: WireVideo
  duration?: unknown
  create_time?: unknown
  preview_title?: string
  item_title?: string
  desc?: string
  author?: { uid?: string | number; sec_uid?: string; nickname?: string; avatar_thumb?: unknown }
  statistics?: { digg_count?: unknown; comment_count?: unknown; collect_count?: unknown; share_count?: unknown; play_count?: unknown }
  music?: { id?: string | number; title?: string; author?: string; play_url?: unknown; cover_large?: unknown }
  mix_info?: { mix_id?: string | number; mix_name?: string }
  is_slides?: boolean
}

interface NormalizeOptions {
  source?: "web" | "ssr"
  expectedId?: string
}

const positive = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined
const count = (value: unknown) => value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined
const jsonObject = <T extends object>(value?: T | string): Partial<T> => {
  if (value && typeof value === "object") return value
  try { return (JSON.parse(value || "{}") || {}) as Partial<T> } catch { return {} }
}

export function mediaUrls(value: unknown) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : (value as WireAddress | null | undefined)?.url_list || []
  const candidates = Array.isArray(list) ? list : typeof list === "string" ? [list] : []
  return [...new Set(candidates.filter((url): url is string => {
    if (typeof url !== "string") return false
    try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password } catch { return false }
  }))]
}

function plainText(value: unknown) {
  const text = String(value || "")
  if (!/<\/?[a-z][\s\S]*>/i.test(text)) return text.trim()
  const $ = load(text)
  $("script,style").remove()
  $("br").replaceWith("\n")
  return $.text().trim()
}

function qualityLabel(entry: WireVariant) {
  const definition = jsonObject<{ definition?: string }>(entry.video_extra).definition
  const known: Record<string, string> = { uhd: "4k", "4k": "4k", "2k": "2k", qhd: "2k", fhd: "1080p", hd: "720p", sd: "540p", ld: "360p" }
  if (definition) return known[definition] || String(definition)
  return String(entry.gear_name || "").match(/(?:^|[_-])(2160|1440|1080|720|540|360)p?(?:[_-]|$)/)?.[1]?.replace(/^(.*)$/, "$1p")
}

function sourceFromAddress(address: WireAddress | undefined, entry: WireVariant = {}): MediaSource | null {
  if (!address) return null
  let urls = mediaUrls(address)
  if (!urls.length && address.uri && !/^https?:/i.test(address.uri)) {
    const params = new URLSearchParams({ video_id: address.uri })
    urls = [`https://www.douyin.com/aweme/v1/play/?${params}`]
  } else if (!urls.length) urls = mediaUrls(address.uri)
  if (!urls.length) return null
  return {
    urls, quality: qualityLabel(entry), sizeBytes: positive(address.data_size),
    width: positive(address.width), height: positive(address.height), bitrate: positive(entry.bit_rate),
    codec: entry.is_bytevc1 === 1 ? "h265" : entry.is_bytevc1 === 0 || entry.h264 ? "h264" : undefined,
    format: entry.format || undefined,
  }
}

export function videoSources(video: WireVideo = {}): MediaSource[] {
  const variants = Array.isArray(video.bit_rate) ? video.bit_rate : []
  const sources = variants.map(entry => sourceFromAddress(entry.play_addr, entry)).filter((source): source is MediaSource => Boolean(source))
  for (const [key, h264] of [["play_addr_h264", true], ["play_addr", false], ["download_addr", false]] as const) {
    const source = sourceFromAddress(video[key], { h264 })
    if (source && !sources.some(item => item.urls.join("\n") === source.urls.join("\n"))) sources.push(source)
  }
  return sources
}

export function selectVideoSources(sources: MediaSource[], config: { quality?: string; video_size_limit_mb?: number } = {}) {
  const sizes: Record<string, number> = { "4k": 2160, "2160p": 2160, "2k": 1440, "1440p": 1440, "1080p": 1080, "720p": 720, "540p": 540, "360p": 360 }
  const preferred = config.quality || "adapt"
  const candidates = sources.filter(source => !source.format || source.format.toLowerCase() === "mp4")
  const ordered = [...candidates].sort((a, b) => (sizes[b.quality ?? ""] || 0) - (sizes[a.quality ?? ""] || 0)
    || Number(b.codec === "h264") - Number(a.codec === "h264") || (b.bitrate || 0) - (a.bitrate || 0))
  if (preferred !== "adapt") {
    const exact = ordered.filter(source => source.quality === preferred)
    return [...exact, ...ordered.filter(source => source.quality !== preferred)]
  }
  const limit = Number(config.video_size_limit_mb || 100) * 1024 * 1024
  const fits = ordered.filter(source => source.sizeBytes && source.sizeBytes <= limit)
  if (fits.length) return [...fits, ...ordered.filter(source => !fits.includes(source))]
  const known = ordered.filter((source): source is MediaSource & { sizeBytes: number } => Boolean(source.sizeBytes)).sort((a, b) => a.sizeBytes - b.sizeBytes)
  return [...known, ...ordered.filter(source => !source.sizeBytes)]
}

function articleBlocks(info: WireArticle, warnings: string[]) {
  const content = jsonObject<ArticleContent>(info.article_content)
  const fe = jsonObject<ArticleImages>(info.fe_data)
  const images = Array.isArray(fe.image_list) ? fe.image_list : []
  const replacements = new Map(images.map(image => [image.markdown_url, image.ai_high_image_url || image.high_image_url || image.origin_image_url || image.markdown_url]))
  const blocks: ArticleBlock[] = []
  const markdown = typeof content.markdown === "string" ? content.markdown : ""
  if (markdown) {
    const expression = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:[^)]*)\)/g
    let offset = 0
    for (const match of markdown.matchAll(expression)) {
      const text = plainText(markdown.slice(offset, match.index))
      if (text) blocks.push({ type: "text", text })
      const urls = mediaUrls(replacements.get(match[2]) || match[2])
      if (urls.length) blocks.push({ type: "image", urls, caption: match[1] })
      offset = match.index + match[0].length
    }
    const text = plainText(markdown.slice(offset))
    if (text) blocks.push({ type: "text", text })
  } else {
    const nodes = content.blocks || content.body || content.content
    const visit = (node: unknown, depth = 0): void => {
      if (depth > 12 || !node) return
      if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return }
      if (typeof node === "string") { const text = plainText(node); if (text) blocks.push({ type: "text", text }); return }
      if (typeof node !== "object") return
      const { url_list, image, url, src, type, tag, text, children, content, body } = node as ArticleNode
      const urls = mediaUrls(url_list || image?.url_list || url || src)
      if (urls.length && /image|img|picture/.test(String(type || tag || ""))) blocks.push({ type: "image", urls })
      else if (typeof text === "string") visit(text, depth + 1)
      else visit(children || content || body, depth + 1)
    }
    visit(nodes)
    if (!blocks.length) {
      warnings.push("文章正文结构未知，已保留可读内容")
      if (typeof info.article_content === "string" && !Object.keys(content).length) visit(info.article_content)
      for (const image of images) {
        const urls = mediaUrls(image.high_image_url || image.origin_image_url || image.markdown_url)
        if (urls.length) blocks.push({ type: "image", urls })
      }
    }
  }
  return { blocks, cover: mediaUrls(content.head_poster_list)[0], markdown }
}

export function normalizeDouyinWork(detail: AwemeDetail, { source = "web", expectedId }: NormalizeOptions = {}) {
  const id = String(detail?.aweme_id || "")
  if (!/^\d+$/.test(id) || expectedId && id !== expectedId) throw new DouyinError("invalid_detail", "作品详情 ID 不匹配")
  const warnings = source === "ssr" ? ["使用分享页面降级解析，部分统计或清晰度信息可能缺失"] : []
  const images = Array.isArray(detail.images) ? detail.images : []
  const isArticle = detail.aweme_type === 163 || Boolean(detail.article_info)
  const media = images.map((image, index): MediaItem => {
    const urls = mediaUrls(image)
    const motion = videoSources(image.video || {})
    const type = image.clip_type === 4 && motion.length ? "video" : motion.length || image.clip_type === 5 ? "live_photo" : "image"
    if (!urls.length && !motion.length) warnings.push(`第 ${index + 1} 项缺少媒体地址`)
    if ((type === "live_photo" || image.clip_type === 4) && !motion.length) warnings.push(`第 ${index + 1} 项动态资源缺失，保留静态图`)
    return { index: index + 1, type, urls, sources: motion, width: positive(image.width), height: positive(image.height) }
  })
  const article = isArticle ? articleBlocks(detail.article_info || {}, warnings) : undefined
  const sources = isArticle || images.length ? [] : videoSources(detail.video || {})
  const type = isArticle ? "article" : images.length ? (media.some(item => item.type === "live_photo") ? "live_photo" : "gallery") : "video"
  if (type === "video") media.push({ index: 1, type: "video", sources, urls: [] })
  if (article) {
    media.splice(0, media.length, ...article.blocks.filter(block => block.type === "image").map((block, index) => ({ ...block, index: index + 1, sources: [] })))
    if (!article.blocks.length && detail.desc) article.blocks.push({ type: "text", text: plainText(detail.desc) })
  }
  if ((type === "video" && !sources.length) || (type !== "video" && !isArticle && !media.some(item => item.urls.length || item.sources.length))) {
    throw new DouyinError("no_media", "作品详情缺少可用媒体资源")
  }
  const author = detail.author || {}
  const statistics = detail.statistics || {}
  const createdAt = positive(detail.create_time)
  const title = plainText(detail.article_info?.article_title || detail.preview_title || detail.item_title || detail.desc || `抖音作品 ${id}`)
  return {
    platform: "douyin" as const, id, type, title, desc: plainText(detail.desc), owner: author.nickname || "",
    author: { id: String(author.uid || ""), secUid: author.sec_uid || "", name: author.nickname || "", avatar: mediaUrls(author.avatar_thumb)[0] },
    cover: article?.cover || mediaUrls(detail.video?.origin_cover)[0] || mediaUrls(detail.video?.cover)[0] || media[0]?.urls?.[0] || "",
    url: `https://www.douyin.com/${isArticle ? "article" : images.length ? "note" : "video"}/${id}`,
    createdAt, duration: (positive(detail.video?.duration || detail.duration) || 0) / 1000,
    stat: { like: count(statistics.digg_count), reply: count(statistics.comment_count), favorite: count(statistics.collect_count), share: count(statistics.share_count), view: count(statistics.play_count) },
    music: detail.music ? { id: String(detail.music.id || ""), title: detail.music.title || "", author: detail.music.author || "", urls: mediaUrls(detail.music.play_url), cover: mediaUrls(detail.music.cover_large)[0] } : undefined,
    collection: detail.mix_info ? { id: String(detail.mix_info.mix_id || ""), title: detail.mix_info.mix_name || "" } : undefined,
    isCollection: detail.is_slides === true, media, sources, article, source, warnings,
  }
}

export type DouyinWork = ReturnType<typeof normalizeDouyinWork>
