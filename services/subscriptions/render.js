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

function textBlock(item, settings) {
  return [item.title,clipContent(item.content,settings)].filter(Boolean).join("\n")
}

function mediaFor(provider, item, settings) {
  return [...new Set([item.cover,...(item.images ?? [])].map(value => imageLink(provider,value)).filter(Boolean))]
    .slice(0,settings.pictureLimit)
}

function textMessages(provider, post, settings) {
  const heading = "【" + provider.label + (provider.typeNames[post.type] || "动态") + "】" + post.author
  const elements = [heading,time.format(post.createdAt*1000),textBlock(post,settings)]
  if (post.forwarded) elements.push("转发 · " + post.forwarded.author,textBlock(post.forwarded,settings))
  elements.push(post.url)
  const message = elements.filter(Boolean).join("\n")
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
    drawBlocks.push({lines:breakLines(metrics,"转发 · "+post.forwarded.author,22,748,true),size:22,bold:true,gap:12})
    const content=textBlock(post.forwarded,settings)
    if (content) drawBlocks.push({lines:breakLines(metrics,content,22,748),size:22,gap:12})
    pushImages(forwarded)
  }

  const max = Math.max(700,Math.min(4300,settings.split?settings.splitHeight:settings.noSplitHeight))
  const pages=[[]]
  let filled=0
  const place=(block,required)=>{
    if (filled && filled+required+310>max) {
      if (!settings.split) return false
      pages.push([])
      filled=0
    }
    pages.at(-1).push(block)
    filled+=required
    return true
  }
  for (const block of drawBlocks) {
    if (block.lines) {
      const lineHeight=Math.ceil(block.size*1.53)
      for (const line of block.lines) if (!place({...block,lines:[line],gap:0},lineHeight)) break
      if (!place({gap:block.gap},block.gap)) break
    } else if(!place(block,block.height+block.gap)) break
  }
  return Promise.all(pages.map(async (blocks,index)=>{
    const elementHeight=block=>block.lines?block.lines.length*Math.ceil(block.size*1.53)+block.gap:(block.height||0)+block.gap
    const height=310+blocks.reduce((total,block)=>total+elementHeight(block),0)
    const rendered=await renderPng(width*2,height*2,ctx=>{
      ctx.scale(2,2)
      ctx.fillStyle="#f9f9f9";ctx.fillRect(0,0,width,height)
      ctx.shadowBlur=18;ctx.shadowColor="rgba(246,140,224,.23)"
      rounded(ctx,20,16,788,height-32,8,"#fff",pink)
      ctx.shadowBlur=0
      if(avatar) drawPicture(ctx,avatar,40,34,88,88,44,true)
      const left=avatar?145:40
      const name=breakLines(metrics,post.author,25,520,true).slice(0,1)
      linesAt(ctx,name,left,51,25,ink,true)
      linesAt(ctx,[time.format(post.createdAt*1000)],left,88,16,"#666")
      linesAt(ctx,[provider.label+" · "+(provider.typeNames[post.type]||"动态")],625,59,20,"#bb507e",true)
      ctx.setLineDash([6,5]);ctx.strokeStyle=divider
      ctx.beginPath();ctx.moveTo(40,142);ctx.lineTo(788,142);ctx.stroke()
      let y=158
      for(const block of blocks){
        if(block.lines) linesAt(ctx,block.lines,40,y,block.size,ink,block.bold)
        else if(block.row) for(const [column,img] of block.row.entries()){
          drawPicture(ctx,img,40+column*(block.cellWidth+8),y,block.cellWidth,block.height,6,block.row.length>1)
        }
        y+=elementHeight(block)
      }
      ctx.strokeStyle=pink;ctx.beginPath();ctx.moveTo(40,y+4);ctx.lineTo(788,y+4);ctx.stroke();ctx.setLineDash([])
      drawPicture(ctx,qr,40,y+18,114,114,4)
      linesAt(ctx,["扫码查看原动态",pages.length>1?"第 "+(index+1)+" / "+pages.length+" 页":provider.label+"动态订阅"],179,y+49,20,"#555")
    },process.env.LOTUS_SKIA_MODE||"auto")
    onRender?.(rendered.engine)
    return rendered.png
  }))
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
