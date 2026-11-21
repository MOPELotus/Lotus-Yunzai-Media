import { join } from "node:path"
import { Canvas, FontLibrary, loadImage } from "skia-canvas"
import QRCode from "qrcode"
import { renderPng } from "@lotus-yunzai/skia"
import { resourcesPath, resolveData } from "../../core/path.js"

// Layout and colors from Yuki's dynamic MainPage, Account, Content and Footer (MIT).
const width = 828
const pink = "#ff69b4", divider = "#ffcee6", ink = "#333"
const bodyFont = '"SubscriptionMiSans", "Noto Sans CJK SC", sans-serif'
const time = new Intl.DateTimeFormat("zh-CN",{
  timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",
})
const mediaDomains = {
  bilibili:["hdslb.com","biliimg.com"], weibo:["sinaimg.cn","sinaimg.com","weibocdn.com","weibo.com"],
}

let fonts
async function enableFonts() {
  fonts ??= (async () => {
    for (const file of [join(resourcesPath,"fonts/MiSans-VF.ttf"),resolveData("atlas/theme/fonts/MiSans-VF.ttf")]) {
      if (await Bun.file(file).exists()) { FontLibrary.use("SubscriptionMiSans",[file]); break }
    }
  })()
  await fonts
}

function imageLink(provider, value) {
  const url = typeof value === "string" && URL.parse(value)
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port ||
      !mediaDomains[provider.id]?.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain))) return
  return url.href
}

async function picture(url, signal) {
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
    const image = await loadImage(Buffer.concat(parts,bytes))
    if (image.width > 14000 || image.height > 14000) return
    return image
  } catch { return }
}

function clipContent(content, settings) {
  if (!content || settings.contentLimit === 0 || settings.lineLimit === 0) return ""
  return Array.from(content.split(/\r?\n/u).slice(0,settings.lineLimit).join("\n")).slice(0,settings.contentLimit).join("")
}

function limitTextContent({content,type}, settings) {
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

function textBlock(item, content) {
  return [item.title,content].filter(Boolean).join("\n")
}

function mediaFor(provider, item, settings) {
  return [...new Set([item.cover,...(item.images ?? [])].map(value => imageLink(provider,value)).filter(Boolean))]
    .slice(0,settings.pictureLimit)
}

function compactCount(value) {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 10_000 ? `${(count/10_000).toFixed(1)}万` : value
}

function textDetails(post) {
  const details = post.activity
  if (!details) return []
  if (post.type === "DYNAMIC_TYPE_LIVE_RCMD") {
    return [details.area && `分区：${details.area}`, details.viewers !== undefined && `${compactCount(details.viewers)}人看过`]
  }
  const stats = [
    ["弹幕", details.bullets], ["播放", details.views], ["点赞", compactCount(details.likes)],
    ["评论", compactCount(details.comments)], ["转发", compactCount(details.shares)],
  ]
  return [stats.filter(([,value]) => value !== undefined).map(([label,value]) => value + label).join(" • ")]
}

function category(provider, post) {
  return provider.typeNames[post.type] || "动态"
}

function published(post) {
  return post.activity?.openedAt ? "开播：" + time.format(post.activity.openedAt*1000) : time.format(post.createdAt*1000)
}

function textPublished(post) {
  const openedAt = post.activity?.openedAt
  const parts = time.formatToParts((openedAt || post.createdAt) * 1000)
  const {year,month,day,hour,minute,second} = Object.fromEntries(parts.map(({type,value})=>[type,value]))
  return (openedAt ? "开播：" : "投稿：") + `${year}年${month}月${day}日 ${hour}:${minute}:${second}`
}

function textMessages(provider, post, settings) {
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
  const message = {type:"text",text:elements.filter(Boolean).join("\n")}
  const media = [...new Set([...mediaFor(provider,post,settings),...(post.forwarded?mediaFor(provider,post.forwarded,settings):[])])]
    .slice(0,settings.pictureLimit).map(file=>({type:"image",file}))
  return media.length ? (settings.merge ? [[message,...media]] : [message,...media]) : [message]
}

function rounded(ctx,x,y,w,h,r,fill,stroke) {
  ctx.beginPath()
  ctx.roundRect(x,y,w,h,r)
  ctx.fillStyle=fill
  ctx.fill()
  if (stroke) { ctx.strokeStyle=stroke; ctx.stroke() }
}

function drawPicture(ctx,img,x,y,w,h,r,cover=false) {
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x,y,w,h,r)
  ctx.clip()
  const ratio = (cover?Math.max:Math.min)(w/img.width,h/img.height)
  const dw=ratio*img.width,dh=ratio*img.height
  ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh)
  ctx.restore()
}

function breakLines(metrics, content, size, space, bold=false) {
  metrics.font=(bold?"bold ":"")+size+"px "+bodyFont
  const lines = []
  for (const paragraph of String(content || "").split(/\r?\n/u)) {
    if (!paragraph) { lines.push(""); continue }
    let line=""
    for (const char of paragraph) {
      if (line && metrics.measureText(line+char).width > space) { lines.push(line); line="" }
      line+=char
    }
    lines.push(line)
  }
  return lines
}

function linesAt(ctx,lines,x,y,size,color,bold=false) {
  ctx.fillStyle=color
  ctx.font=(bold?"bold ":"")+size+"px "+bodyFont
  ctx.textBaseline="top"
  for (let i=0;i<lines.length;i++) ctx.fillText(lines[i],x,y+i*Math.ceil(size*1.53))
}

async function drawDynamic(provider,post,settings,signal,onRender) {
  await enableFonts()
  const build = item => Promise.all(mediaFor(provider,item,settings).map(url=>picture(url,signal)))
  const avatarUrl = imageLink(provider,post.avatar)
  const [avatar,images,forwarded,qr] = await Promise.all([
    avatarUrl && picture(avatarUrl,signal),
    build(post),
    post.forwarded ? build(post.forwarded) : [],
    QRCode.toBuffer(post.url,{width:144,margin:1}).then(loadImage),
  ])
  signal?.throwIfAborted()
  const metricCanvas = new Canvas(1,1)
  metricCanvas.gpu=false
  const metrics=metricCanvas.getContext("2d")
  const title=breakLines(metrics,post.title,28,748,true)
  const body=breakLines(metrics,clipContent(post.content,settings),24,748)
  const drawBlocks=[]
  if(post.title) drawBlocks.push({lines:title,size:28,bold:true,gap:12})
  if(post.content) drawBlocks.push({lines:body,size:24,gap:12})
  const pushImages = list => {
    const good = list.filter(Boolean)
    const grid = settings.grid && good.length >= 2
    const columns = grid ? (good.length <= 4?2:3) : 1
    const gap = 8
    for (let i=0;i<good.length;i+=columns) {
      const row = good.slice(i,i+columns)
      const cellWidth = Math.floor((748-(columns-1)*gap)/columns)
      const height = grid ? Math.min(320,cellWidth) : Math.max(96,Math.min(720,Math.round(cellWidth*row[0].height/row[0].width)))
      drawBlocks.push({row,cellWidth,height,gap:12})
    }
  }
  pushImages(images)
  if (post.forwarded) {
    const original = post.forwarded
    const heading = `原帖 · ${category(provider,original)} · ${original.author}`
    drawBlocks.push({lines:breakLines(metrics,heading,22,748,true),size:22,bold:true,gap:2})
    drawBlocks.push({lines:[published(original)],size:16,gap:10,color:"#666"})
    const content=textBlock(original,clipContent(original.content,settings))
    if (content) drawBlocks.push({lines:breakLines(metrics,content,22,748),size:22,gap:12})
    pushImages(forwarded)
  }

  const bodyTop = 158
  let bodyBottom = bodyTop
  const blocks = drawBlocks.map(block => {
    const top = bodyBottom
    const blockHeight = block.lines ? block.lines.length*Math.ceil(block.size*1.53) : block.height
    bodyBottom += blockHeight + block.gap
    return { ...block,top,bottom:bodyBottom }
  })
  // Yuki clips only the content container in single-image mode. In split mode,
  // the author, content and footer form one card that is sliced after layout.
  const footerTop = settings.split ? bodyBottom : Math.min(bodyBottom,bodyTop+settings.noSplitHeight)
  const height = footerTop + 152
  const pageCount = settings.split ? Math.ceil(height/settings.splitHeight) : 1
  // Keep the 2x resolution where it fits a 16K GPU surface, without reducing the layout height.
  const scale = Math.ceil(height/pageCount)*2 <= 16384 ? 2 : 1
  const pages = []
  for (let index=0;index<pageCount;index++) {
    signal?.throwIfAborted()
    const top = Math.floor(height*index/pageCount)
    const bottom = Math.floor(height*(index+1)/pageCount)
    const rendered=await renderPng(width*scale,(bottom-top)*scale,ctx=>{
      ctx.scale(scale,scale)
      ctx.translate(0,-top)
      ctx.fillStyle="#f9f9f9";ctx.fillRect(0,0,width,height)
      ctx.shadowBlur=18;ctx.shadowColor="rgba(246,140,224,.23)"
      rounded(ctx,20,16,788,height-32,8,"#fff",pink)
      ctx.shadowBlur=0
      if(avatar) drawPicture(ctx,avatar,40,34,88,88,44,true)
      const left=avatar?145:40
      const name=breakLines(metrics,post.author,25,520,true).slice(0,1)
      linesAt(ctx,name,left,51,25,ink,true)
      linesAt(ctx,[time.format(post.createdAt*1000)],left,88,16,"#666")
      linesAt(ctx,[provider.label+" · "+category(provider,post)],625,59,20,"#bb507e",true)
      ctx.setLineDash([6,5]);ctx.strokeStyle=divider
      ctx.beginPath();ctx.moveTo(40,142);ctx.lineTo(788,142);ctx.stroke()
      ctx.save()
      ctx.beginPath()
      ctx.rect(0,bodyTop,width,footerTop-bodyTop)
      ctx.clip()
      for(const block of blocks){
        if (block.bottom<=top || block.top>=bottom || block.top>=footerTop) continue
        if(block.lines) linesAt(ctx,block.lines,40,block.top,block.size,block.color || ink,block.bold)
        else if(block.row) for(const [column,img] of block.row.entries()){
          drawPicture(ctx,img,40+column*(block.cellWidth+8),block.top,block.cellWidth,block.height,6,block.row.length>1)
        }
      }
      ctx.restore()
      const y = footerTop
      ctx.strokeStyle=pink;ctx.beginPath();ctx.moveTo(40,y+4);ctx.lineTo(788,y+4);ctx.stroke();ctx.setLineDash([])
      drawPicture(ctx,qr,40,y+18,114,114,4)
      const qrCaption = post.type === "DYNAMIC_TYPE_FORWARD" ? "扫码查看这条转发" : "扫码查看原动态"
      linesAt(ctx,[qrCaption,provider.label+"动态订阅"],179,y+49,20,"#555")
    },process.env.LOTUS_SKIA_MODE||"auto")
    onRender?.(rendered.engine)
    pages.push(rendered.png)
  }
  return pages
}

export async function makeDynamicMessages(provider,post,settings,{signal,onRender}={}) {
  if (settings.picture) {
    try {
      const images = await drawDynamic(provider,post,settings,signal,onRender)
      return images.map((file,index)=>index===images.length-1?[{type:"image",file},post.url]:{type:"image",file})
    } catch (error) {
      if (signal?.aborted) throw error
    }
  }
  return textMessages(provider,post,settings)
}
