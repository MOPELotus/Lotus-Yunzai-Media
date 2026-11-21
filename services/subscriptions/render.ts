import { loadImage, type CanvasRenderingContext2D, type Image } from "skia-canvas"
import QRCode from "qrcode"
import { ImageSizeLimitError } from "@lotus-yunzai/skia"
import { drawInfoText, infoCardColors, measureInfoText, renderInfoCardPages, type InfoCardOptions } from "@lotus-yunzai/skia/info-card"

import type { MessageReply } from "../../../../lib/messages.ts"
import type { SubscriptionSettings } from "./config.ts"
import type { DynamicPost, SubscriptionProvider } from "./types.ts"

type RenderProvider = Pick<SubscriptionProvider, "id" | "label" | "typeNames">
type PageEngine = Awaited<ReturnType<typeof renderInfoCardPages>>[number]["engine"]

export interface DynamicRenderOptions {
  signal?: AbortSignal
  inlineImageByteLimit?: number
  onRender?: (engine: PageEngine) => void
}

interface DrawBlock {
  top: number
  bottom: number
  draw: (ctx: CanvasRenderingContext2D, y: number) => void
}

export function subscriptionRenderMode(): NonNullable<InfoCardOptions["mode"]> {
  const mode = process.env.LOTUS_SKIA_MODE
  return mode === "gpu" || mode === "cpu" ? mode : "auto"
}

const width = 828
const time = new Intl.DateTimeFormat("zh-CN",{
  timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",
})
const mediaDomains = {
  bilibili:["hdslb.com","biliimg.com"], weibo:["sinaimg.cn","sinaimg.com","weibocdn.com","weibo.com"],
}

function imageLink(provider: RenderProvider, value: unknown) {
  const url = typeof value === "string" && URL.parse(value)
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port ||
      !mediaDomains[provider.id]?.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain))) return
  return url.href
}

function picture(url: string, signal: AbortSignal | undefined, encoded: true): Promise<Buffer | undefined>
function picture(url: string, signal?: AbortSignal): Promise<Image | undefined>
async function picture(url: string, signal?: AbortSignal, encoded = false): Promise<Buffer | Image | undefined> {
  try {
    const timeout = AbortSignal.timeout(12000)
    const response = await fetch(url,{redirect:"error",credentials:"omit",signal:signal?AbortSignal.any([signal,timeout]):timeout})
    const max = 8*1024*1024
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > max) {
      await response.body?.cancel()
      return
    }
    const parts = []
    let bytes = 0
    for await (const part of response.body) {
      bytes += part.byteLength
      if (bytes > max) return
      parts.push(part)
    }
    if (!bytes) return
    const buffer = Buffer.concat(parts, bytes)
    const image = await loadImage(buffer)
    if (image.width > 14000 || image.height > 14000) return
    return encoded ? buffer : image
  } catch { return }
}

function clipContent(content: string, settings: SubscriptionSettings) {
  if (!content || settings.contentLimit === 0 || settings.lineLimit === 0) return ""
  return Array.from(content.split(/\r?\n/u).slice(0,settings.lineLimit).join("\n")).slice(0,settings.contentLimit).join("")
}

function limitTextContent({content,type}: DynamicPost, settings: SubscriptionSettings) {
  if (!content || settings.contentLimit === 0 || settings.lineLimit === 0) return ""
  if (type === "DYNAMIC_TYPE_AV") return content
  const lines = []
  let remaining = settings.contentLimit
  for (const line of content.split(/\r?\n/u).slice(0,settings.lineLimit)) {
    if (!remaining) break
    const characters = Array.from(line)
    if (characters.length > remaining) {
      lines.push(characters.slice(0,remaining).join("") + "...")
      break
    }
    lines.push(line)
    remaining -= characters.length
  }
  return lines.join("\n")
}

function textBlock(item: DynamicPost, content: string) {
  return [item.title,content].filter(Boolean).join("\n")
}

function mediaFor(provider: RenderProvider, item: DynamicPost, settings: SubscriptionSettings) {
  return [...new Set([item.cover,...(item.images ?? [])].map(value => imageLink(provider,value)).filter(url => url !== undefined))]
    .slice(0,settings.pictureLimit)
}

function compactCount(value?: string) {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 10_000 ? `${(count/10_000).toFixed(1)}万` : value
}

function textDetails(post: DynamicPost) {
  const details = post.activity
  if (!details) return []
  if (post.type === "DYNAMIC_TYPE_LIVE_RCMD") {
    return [details.area && `分区：${details.area}`, details.viewers !== undefined && `${compactCount(details.viewers)}人看过`]
  }
  const stats = [
    ["弹幕", details.bullets], ["播放", details.views], ["点赞", compactCount(details.likes)],
    ["评论", compactCount(details.comments)], ["转发", compactCount(details.shares)],
  ]
  return [stats.filter(([,value]) => value !== undefined).map(([label,value]) => `${value}${label}`).join(" • ")]
}

function category(provider: RenderProvider, post: DynamicPost) {
  return provider.typeNames[post.type] || "动态"
}

function published(post: DynamicPost) {
  return post.activity?.openedAt ? "开播：" + time.format(post.activity.openedAt*1000) : time.format(post.createdAt*1000)
}

function textPublished(post: DynamicPost) {
  const openedAt = post.activity?.openedAt
  const parts = time.formatToParts((openedAt || post.createdAt) * 1000)
  const {year,month,day,hour,minute,second} = Object.fromEntries(parts.map(({type,value})=>[type,value]))
  return (openedAt ? "开播：" : "投稿：") + `${year}年${month}月${day}日 ${hour}:${minute}:${second}`
}

function textMessages(provider: RenderProvider, post: DynamicPost, settings: SubscriptionSettings): MessageReply[] {
  const heading = `【${provider.label}${category(provider,post)}】${post.author}`
  const repost = post.type === "DYNAMIC_TYPE_FORWARD"
  const linkLabel = post.activity?.roomUrl ? "直播链接" : repost ? "转发链接" : "链接"
  const elements = [heading,textPublished(post),textBlock(post,limitTextContent(post,settings)),...textDetails(post),`${linkLabel}：${post.url}`]
  const original = post.forwarded
  if (original) {
    elements.push(`原帖 · ${category(provider,original)} · ${original.author}`,textPublished(original),
      textBlock(original,limitTextContent(original,settings)),...textDetails(original))
    if (original.url !== post.url) {
      const label = original.activity?.roomUrl ? "原帖直播链接" : "原帖链接"
      elements.push(`${label}：${original.url}`)
    }
  }
  const message = {type:"text" as const,text:elements.filter(Boolean).join("\n")}
  const media = [...new Set([...mediaFor(provider,post,settings),...(post.forwarded?mediaFor(provider,post.forwarded,settings):[])])]
    .slice(0,settings.pictureLimit).map(file=>({type:"image" as const,file}))
  return media.length ? (settings.merge ? [[message,...media]] : [message,...media]) : [message]
}

function drawPicture(ctx: CanvasRenderingContext2D, img: Image, x: number, y: number, w: number, h: number, r: number, cover = false) {
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x,y,w,h,r)
  ctx.clip()
  const ratio = (cover?Math.max:Math.min)(w/img.width,h/img.height)
  const dw=ratio*img.width,dh=ratio*img.height
  ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh)
  ctx.restore()
}

async function drawDynamic(provider: RenderProvider, post: DynamicPost, settings: SubscriptionSettings,
  { signal, inlineImageByteLimit = Infinity, onRender }: DynamicRenderOptions) {
  const build = (item: DynamicPost) => Promise.all(mediaFor(provider, item, settings).map(url => picture(url, signal)))
  const avatarUrl = imageLink(provider, post.avatar)
  const [avatar, images, forwarded, qr] = await Promise.all([
    avatarUrl ? picture(avatarUrl, signal, true) : undefined,
    build(post),
    post.forwarded ? build(post.forwarded) : [],
    QRCode.toBuffer(post.url, { width: 144, margin: 1 }).then(loadImage),
  ])
  signal?.throwIfAborted()

  const label = `${provider.label} · ${category(provider, post)}`
  const metadata = [post.title && label, time.format(post.createdAt * 1000)].filter(Boolean).join(" · ")
  const render = (scale: 2 | 4) => renderInfoCardPages({ title: post.title || label, eyebrow: post.author, metadata, icon: avatar, width }, layout => {
    const x = layout.x + 10
    const contentWidth = layout.width - 20
    const bodyTop = layout.y
    const blocks: DrawBlock[] = []
    let cursor = bodyTop

    function append(height: number, gap: number, draw: DrawBlock["draw"]) {
      blocks.push({ top: cursor, bottom: cursor + height + gap, draw })
      cursor += height + gap
    }

    function appendText(value: string, size: number, gap: number, color: string = infoCardColors.text) {
      const lines = measureInfoText(layout.measure, value, contentWidth, size)
      const leading = Math.ceil(size * 1.53)
      append(lines.length * leading, gap, (ctx, y) => drawInfoText(ctx, lines, x, y, { size, leading, color }))
    }

    function appendImages(list: readonly (Image | undefined)[]) {
      const good = list.filter(image => image !== undefined)
      const grid = settings.grid && good.length >= 2
      const columns = grid ? (good.length <= 4 ? 2 : 3) : 1
      const gap = 8
      for (let index = 0; index < good.length; index += columns) {
        const row = good.slice(index, index + columns)
        const first = good[index]!
        const cellWidth = Math.floor((contentWidth - (columns - 1) * gap) / columns)
        const height = grid ? Math.min(320, cellWidth)
          : Math.max(96, Math.min(720, Math.round(cellWidth * first.height / first.width)))
        append(height, 12, (ctx, y) => {
          for (const [column, image] of row.entries()) {
            drawPicture(ctx, image, x + column * (cellWidth + gap), y, cellWidth, height, 6, row.length > 1)
          }
        })
      }
    }

    if (post.content) appendText(clipContent(post.content, settings), 24, 12)
    appendImages(images)
    const original = post.forwarded
    if (original) {
      appendText(`原帖 · ${category(provider, original)} · ${original.author}`, 22, 2, infoCardColors.gold)
      appendText(published(original), 16, 10, infoCardColors.muted)
      const content = textBlock(original, clipContent(original.content, settings))
      if (content) appendText(content, 22, 12)
      appendImages(forwarded)
    }

    // Keep Yuki's one-layout pagination and clip only the body in single-image mode.
    const footerTop = settings.split ? cursor : Math.min(cursor, bodyTop + settings.noSplitHeight)
    return { height: footerTop - bodyTop + 152, draw(ctx, { top, bottom }) {
      signal?.throwIfAborted()
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, bodyTop, contentWidth, footerTop - bodyTop)
      ctx.clip()
      for (const block of blocks) {
        if (block.bottom > top && block.top < bottom && block.top < footerTop) block.draw(ctx, block.top)
      }
      ctx.restore()
      ctx.fillStyle = infoCardColors.rule
      ctx.fillRect(x, footerTop + 4, contentWidth, 1)
      drawPicture(ctx, qr, x, footerTop + 18, 114, 114, 4)
      const caption = post.type === "DYNAMIC_TYPE_FORWARD" ? "扫码查看这条转发" : "扫码查看原动态"
      drawInfoText(ctx, [caption], x + 139, footerTop + 48, { size: 20, color: infoCardColors.gold })
      drawInfoText(ctx, [`${provider.label}动态订阅`], x + 139, footerTop + 79, { size: 20, color: infoCardColors.muted })
    } }
  }, {
    pageHeight: settings.split ? settings.splitHeight : undefined,
    scale,
    mode: subscriptionRenderMode(),
    allowHalfScale: false,
  })
  let pages = await render(4).catch(error => {
    if (!(error instanceof ImageSizeLimitError)) throw error
  })
  const oversized = (page: { readonly png: Uint8Array }) => page.png.byteLength > inlineImageByteLimit
  if (!pages || pages.some(oversized)) {
    signal?.throwIfAborted()
    pages = await render(2)
  }
  if (pages.some(oversized)) throw new ImageSizeLimitError("动态图片超过当前会话大小上限。")
  return pages.map(page => {
    onRender?.(page.engine)
    return page.png
  })
}

export async function makeDynamicMessages(provider: RenderProvider, post: DynamicPost, settings: SubscriptionSettings,
  options: DynamicRenderOptions = {}): Promise<MessageReply[]> {
  if (settings.picture) {
    try {
      const images = await drawDynamic(provider,post,settings,options)
      return images.map((file,index)=>index===images.length-1?[{type:"image",file},post.url]:{type:"image",file})
    } catch (error) {
      if (options.signal?.aborted) throw error
    }
  }
  return textMessages(provider,post,settings)
}
