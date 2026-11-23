import path from "node:path"
import { Canvas, FontLibrary, loadImage, type CanvasRenderingContext2D, type Image, type EngineDetails } from "skia-canvas"
import { renderPng } from "@lotus-yunzai/skia"
import { resourcesPath, resolveData } from "../path.ts"
import { fetchImageBytes } from "./image.ts"
import { plainGameText } from "./plain-text.ts"
import type { ArticleBlock } from "../../services/media/message.ts"

export type SourceTemplate = "status" | "bilibili-info" | "douyin-info" | "acfun-info" | "pipixia-info" | "article"

export interface RenderOptions {
 readonly mode?: Parameters<typeof renderPng>[3]
 readonly renderScale?: number
 readonly saveId?: string
 readonly onRender?: (engine: EngineDetails) => void
}

type StatusRow = string | { readonly label?: string; readonly title?: string; readonly value?: unknown; readonly body?: unknown }

export interface SourceCard {
 readonly title?: string
 readonly subtitle?: string
 readonly message?: string
 readonly userId?: number | string
 readonly badge?: string
 readonly items?: readonly StatusRow[]
 readonly generatedAt?: string
 readonly avatar?: string
 readonly owner?: string
 readonly page?: number
 readonly id?: string
 readonly type?: string
 readonly desc?: string
 readonly cover?: string
 readonly image?: string
 readonly blocks?: readonly ArticleBlock[]
 readonly duration?: number
 readonly createdAt?: number
 readonly media?: readonly unknown[]
 readonly warnings?: readonly string[]
 readonly music?: { readonly title?: string; readonly author?: string }
 readonly collection?: { readonly title?: string }
 readonly sources?: readonly { readonly quality?: string; readonly width?: number; readonly height?: number; readonly codec?: string }[]
 readonly stat?: Partial<Record<"like" | "reply" | "favorite" | "coin" | "view" | "danmaku" | "share", number>>
 readonly online?: number
 readonly liveStatus?: string
}

interface TextOptions {
 readonly align?: CanvasRenderingContext2D["textAlign"]
 readonly font?: string
 readonly leading?: number
 readonly minSize?: number
 readonly shadow?: boolean
 readonly singleLine?: boolean
 readonly literal?: boolean
}

interface ImageOptions { readonly cover?: boolean; readonly radius?: number }
interface VisiblePage { readonly top: number; readonly bottom: number }
type Draw = (ctx: CanvasRenderingContext2D, images: ReadonlyMap<string, Image | null>, visible: VisiblePage) => void

export function renderMode(configured = process.env.LOTUS_SKIA_MODE): NonNullable<RenderOptions["mode"]> {
 if(configured===undefined||configured==="auto")return "auto"
 return configured==="gpu"?"gpu":"cpu"
}

// Bilibili and Douyin retain the genshin mysNews layout drawn by Lotus-ReFactor.
export const mediaNewsColors = { gold: '#d3bc8e', text: '#fff', muted: '#c2c5cb', rule: 'rgba(211,188,142,.35)' } as const
const { gold: GOLD, text: WHITE, muted: MUTED, rule: RULE } = mediaNewsColors
const TEXT='"MediaSourceText", MiSans, sans-serif'
let fontsLoaded=false
const cache=new Map<string, Promise<Image | null>>()


const background = path.join(resourcesPath, "miao-theme/bg/bg-hydro.webp")

async function init() {
 if(fontsLoaded)return
 for (const [name, candidates] of [
  ["MediaSourceText", [path.join(resourcesPath,"miao-theme/fonts/HYWH-65W.ttf"),resolveData("atlas/theme/fonts/HYWH-65W.ttf")]],
  ["MiSans", [path.join(resourcesPath,"fonts/MiSans-VF.ttf"),resolveData("atlas/theme/fonts/MiSans-VF.ttf")]],
 ] as const) {
  for (const candidate of candidates) {
   if (await Bun.file(candidate).exists()) { FontLibrary.use(name,[candidate]); break }
  }
 }
 fontsLoaded=true
}

async function getImage(src: string | undefined) {
 if(!src)return null
 if(!cache.has(src)){
  cache.set(src,(async()=>{
   if(src===background){
    return loadImage(background).catch(()=>loadImage(resolveData("atlas/theme/bg/bg-hydro.webp")))
   }
   return loadImage(await fetchImageBytes(src))
  })().catch(()=>{cache.delete(src);return null}))
  const oldest=cache.keys().next().value
  if(cache.size>96&&oldest!==undefined)cache.delete(oldest)
 }
 return cache.get(src)
}


export function drawMediaNewsText(ctx: CanvasRenderingContext2D, lines: readonly string[],
 x: number, y: number, width: number, size: number, color: string, options: TextOptions = {}) {
 const align = options.align || 'left'
 const leading = options.leading || size * 1.5
 ctx.save()
 ctx.font = `${size}px ${options.font || TEXT}`
 ctx.textBaseline = 'top'
 ctx.fillStyle = color
 ctx.textAlign = align
 if (options.shadow) {
  ctx.shadowColor = '#000'
  ctx.shadowBlur = 2
  ctx.shadowOffsetX = 1
  ctx.shadowOffsetY = 1
 }
 const left = x + (align === 'right' ? width : align === 'center' ? width / 2 : 0)
 lines.forEach((line, index) => ctx.fillText(line, left, y + index * leading))
 ctx.restore()
}

export function drawMediaNewsImage(ctx: CanvasRenderingContext2D, img: Image, x: number, y: number,
 w: number, h: number, { radius, cover }: ImageOptions) {
 ctx.save()
 if (radius) { ctx.beginPath(); ctx.roundRect(x,y,w,h,radius); ctx.clip() }
 const ratio = (cover ? Math.max : Math.min)(w/img.width,h/img.height)
 const dw = img.width * ratio, dh = img.height * ratio
 ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh)
 ctx.restore()
}

const damageNumber=(n: unknown)=>Number(n||0).toLocaleString('zh-CN',{maximumFractionDigits:1})

class SourceCanvas{
 readonly commands: Draw[] = []
 readonly refs = new Set<string>()
 readonly ctx: CanvasRenderingContext2D
 y=20
 height=0
 constructor(readonly width: number){const metrics=new Canvas(1,1);metrics.gpu=false;this.ctx=metrics.getContext('2d')}
 lines(value: unknown,width: number,size=16,font=TEXT){
  return this.wrap(plainGameText(value),width,size,font)
 }
 wrap(value: string,width: number,size: number,font=TEXT){
  this.ctx.font=`${size}px ${font}`
  const lines=[]
  for(const paragraph of value.split(/\r?\n/)){
   let line=''
   for(const token of paragraph.match(/[-+]?\d+(?:\.\d+)?%?|[A-Za-z][A-Za-z0-9.-]*|./gu)||[]){
    if(this.ctx.measureText(token).width<=width){if(line&&this.ctx.measureText(line+token).width>width){lines.push(line);line=''}line+=token}
    else for(const ch of token){if(line&&this.ctx.measureText(line+ch).width>width){lines.push(line);line=''}line+=ch}
   }
   lines.push(line)
  }
  return lines
 }
 rect(x: number,y: number,w: number,h: number,fill: string,radius=0){this.commands.push(ctx=>{ctx.fillStyle=fill;ctx.beginPath();ctx.roundRect(x,y,w,h,radius);ctx.fill()})}
 clip(x: number,y: number,w: number,h: number,radius=10){this.commands.push(ctx=>{ctx.save();ctx.beginPath();ctx.roundRect(x,y,w,h,radius);ctx.clip()})}
 restore(){this.commands.push(ctx=>ctx.restore())}
 rule(x: number,y: number,w: number,color='#ddd'){this.rect(x,y,w,1,color)}
 text(value: unknown,x: number,y: number,width: number,size=16,color: string=WHITE,options: TextOptions={}){
  const font=options.font||TEXT
  let lines
  if(options.singleLine){
   const line=plainGameText(value).replace(/\s*\n\s*/g,' ')
   lines=[line]
   this.ctx.font=`${size}px ${font}`
   while(this.ctx.measureText(line).width>width&&size>(options.minSize||10)){size-=.5;this.ctx.font=`${size}px ${font}`}
  }else lines=options.literal ? this.wrap(String(value ?? ''),width,size,font) : this.lines(value,width,size,font)
  const leading=options.leading||size*1.5
  this.commands.push(ctx=>drawMediaNewsText(ctx,lines,x,y,width,size,color,options))
  return lines.length*leading
 }
 image(src: string | Image | undefined,x: number,y: number,w: number,h: number,options: ImageOptions={}){
  if(!src)return
  if(typeof src === 'string')this.refs.add(src)
  this.commands.push((ctx,images)=>{
   const img=typeof src === 'string' ? images.get(src) : src
   if(img)drawMediaNewsImage(ctx,img,x,y,w,h,options)
  })
 }
 log(title: string,rows: readonly StatusRow[],lead=''){
  const top=this.y,w=this.width-25,x=10
  const titleH=this.lines(title,w-40,20).length*28+16
  const contents=[lead,...rows.map(row=>typeof row==='string'?row:`${row.label||row.title||''}：${row.value??row.body??''}`)].filter(Boolean)
  const heights=contents.map(value=>this.lines(value,w-65,14).length*22+8)
  const h=titleH+heights.reduce((a,b)=>a+b,0)+20
  this.clip(x,top,w,h,10)
  this.rect(x,top,w,h,'rgba(0,0,0,.50)')
  this.rect(x,top,w,titleH,'rgba(0,0,0,.40)')
  this.text(title,x+20,top+10,w-40,20,GOLD,{leading:28})
  let y=top+titleH+10
  contents.forEach((value,i)=>{this.text('•',x+20,y,15,14,WHITE);this.text(value,x+40,y,w-65,14,WHITE,{leading:22});y+=heights[i] ?? 0})
  this.restore();this.y+=h+10
 }
 async render(options: RenderOptions) {
  const [page] = await this.renderPages(options)
  return page!.png
 }
 async renderPages(options: RenderOptions, pageHeight?: number, signal?: AbortSignal) {
  const height=Math.max(240,this.y+50)
  this.height=height
  const configured=Number(options.renderScale??process.env.LOTUS_RENDER_SCALE??4)
  const scale=Number.isFinite(configured)?Math.min(4,Math.max(1,configured)):4
  const images=new Map<string, Image | null>()
  await Promise.all([...this.refs].map(async src=>images.set(src,await getImage(src) ?? null)))
  const count=pageHeight === undefined ? 1 : Math.ceil(height / pageHeight)
  const pages=[]
  for (let index=0; index<count; index++) {
   signal?.throwIfAborted()
   const top=Math.floor(height*index/count)
   const bottom=index+1===count ? height : Math.floor(height*(index+1)/count)
   const rendered=await renderPng(Math.round(this.width*scale),Math.ceil((bottom-top)*scale),ctx=>{
    ctx.scale(scale,scale)
    if(top)ctx.translate(0,-top)
    ctx.imageSmoothingEnabled=true
    ctx.imageSmoothingQuality='high'
    for(const draw of this.commands)draw(ctx,images,{top,bottom})
   },options.mode??renderMode())
   options.onRender?.(rendered.engine)
   pages.push(rendered)
  }
  return pages
 }
}
function elemental(p: SourceCanvas){p.rect(0,0,p.width,100000,'#243344');p.commands.push((ctx,images)=>{const img=images.get(background);if(img)ctx.drawImage(img,0,0,p.width,p.height)});p.refs.add(background)}
async function newsImage(p: SourceCanvas,src: string | undefined){
 if(!src)return
 const img=await getImage(src)
 if(!img){p.image(src,30,p.y,p.width-60,200);p.y+=215;return}
 const w=p.width-60,h=Math.min(3200,w*img.height/img.width)
 p.image(src,30,p.y,w,h,{radius:14});p.y+=h+20
}
function mediaStats(data: SourceCard,template: SourceTemplate){
 const s=data.stat||{},format=(n: number | undefined)=>n===undefined?'未记录':damageNumber(n)
 const stats=data.type==='live'?[['直播状态',data.liveStatus],['在线人数',format(data.online)]]:[['点赞',format(s.like)],['评论',format(s.reply)],...(template==='pipixia-info'?[['播放',format(s.view)]]:[['收藏',format(s.favorite)]]),...(template==='bilibili-info'?[['投币',format(s.coin)],['播放',format(s.view)],['弹幕',format(s.danmaku)]]:template==='acfun-info'?[['播放',format(s.view)],['弹幕',format(s.danmaku)],['香蕉',format(s.coin)]]:[['分享',format(s.share)]])]
 return stats.map(([label,value])=>`${label} ${value||'未记录'}`).join('    ')
}
interface MediaNewsHeader {
 readonly owner: string
 readonly title: string
 readonly byline: string
 readonly avatar?: string | Image
 readonly metadata?: string
}

function openNews(p: SourceCanvas, { owner, title, byline, avatar, metadata }: MediaNewsHeader, literal = false) {
 elemental(p)
 const frame={height:0}
 p.commands.push(ctx=>{ctx.fillStyle='rgba(15,20,31,.78)';ctx.beginPath();ctx.roundRect(15,20,p.width-30,frame.height,15);ctx.fill()})
 p.y=40
 if(avatar)p.image(avatar,35,p.y,90,90,{cover:true,radius:45})
 const ownerX=avatar?143:35, ownerWidth=p.width-ownerX-35
 const authorHeight=p.text(owner,ownerX,p.y+16,ownerWidth,30,GOLD,{leading:50,literal})
 const extraAuthor=literal?Math.max(0,authorHeight-50):0
 const bylineHeight=p.text(byline,ownerX,p.y+66+extraAuthor,ownerWidth,22,MUTED,{literal})
 p.y+=130+extraAuthor+(literal?Math.max(0,bylineHeight-33):0)
 p.rule(30,p.y-5,p.width-60,RULE)
 p.y+=p.text(title,30,p.y,p.width-60,44,WHITE,{leading:60,literal})+20
 if (metadata !== undefined) p.y+=p.text(metadata,30,p.y,p.width-60,18,GOLD,{leading:28,literal})+20

 return () => { frame.height=p.y-10; p.y+=15 }
}

function newsFooter(p: SourceCanvas, generatedAt?: string) {
 p.text(`Lotus-Yunzai${generatedAt?' · '+generatedAt:''}`,15,p.y+15,p.width-30,12,WHITE,{align:'center',shadow:true,leading:18})
}

interface MediaNewsBodyLayout {
 readonly x: number
 readonly y: number
 readonly width: number
 readonly lines: (text: string, width: number, size: number) => readonly string[]
}

export async function renderMediaNewsPages(header: MediaNewsHeader, buildBody: (layout: MediaNewsBodyLayout) => {
 readonly height: number
 draw(ctx: CanvasRenderingContext2D, visible: VisiblePage): void
}, options: RenderOptions & { readonly pageHeight?: number; readonly signal?: AbortSignal }) {
 await init()
 const p=new SourceCanvas(900)
 const close=openNews(p,header,true)
 const body=buildBody({ x:30, y:p.y, width:p.width-60, lines:p.wrap.bind(p) })
 p.commands.push((ctx,_images,visible)=>body.draw(ctx,visible))
 p.y+=body.height
 close()
 newsFooter(p)
 return p.renderPages(options,options.pageHeight,options.signal)
}

async function news(p: SourceCanvas,data: SourceCard,template: SourceTemplate){
 // genshin mysNews content order inside Miao help/index's elemental group container.
 const article=template==='article'
 const close=openNews(p,{
  owner:data.owner||'作者资料未记录',
  title:data.title||'作品信息',
  byline:article?`第 ${data.page||1} 页`:data.id||'',
  avatar:data.avatar,
  metadata:article?undefined:[data.type==='live'?'直播':data.type==='gallery'?'图集':data.type==='live_photo'?'动态图片':data.type==='article'?'文章':'视频',data.duration?`${Math.floor(data.duration/60)}分${Math.floor(data.duration%60)}秒`:'',data.createdAt?new Date(data.createdAt*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'',data.media?.length?`${data.media.length} 个媒体项`:''].filter(Boolean).join(' · '),
 })
 if(article){
  for(const block of data.blocks||[]){
   if(block.type==='image')for(const src of block.urls||[])await newsImage(p,src)
   else if(block.text)p.y+=p.text(block.text,30,p.y,p.width-60,22,WHITE,{leading:36})+16
  }
 }else{
  await newsImage(p,data.cover||data.image)
  if(data.desc)p.y+=p.text(data.desc,30,p.y,p.width-60,22,WHITE,{leading:36})+20
  if(data.music?.title)p.y+=p.text(`音乐：${data.music.title} · ${data.music.author||''}`,30,p.y,p.width-60,18,'#c2c5cb')+20
  if(data.collection?.title)p.y+=p.text(`合集：${data.collection.title}`,30,p.y,p.width-60,18,'#c2c5cb')+20
  if(data.sources?.length)p.y+=p.text(`可用视频源：${data.sources.map(source=>[source.quality||'清晰度未记录',source.width&&source.height?`${source.width}×${source.height}`:'',source.codec||''].filter(Boolean).join(' ')).join(' / ')}`,30,p.y,p.width-60,18,'#c2c5cb')+20
  for(const warning of data.warnings||[])p.y+=p.text(warning,30,p.y,p.width-60,18,'#c2c5cb')+16
  p.rule(30,p.y,p.width-60,'rgba(211,188,142,.35)');p.y+=22
  p.y+=p.text(mediaStats(data,template),30,p.y,p.width-60,18,GOLD,{leading:28})+18
 }
 close()
}

export async function renderSourceCard(template: SourceTemplate,data: SourceCard={},options: RenderOptions={}){
 await init()
 const p=new SourceCanvas(template==="status"?600:900)
 if(template==="status"){
  elemental(p)
  p.log(data.title||'Lotus-Yunzai',data.items||[],[data.subtitle,data.message].filter(Boolean).join('\n'))
 }else{
  await news(p,data,template)
 }
 newsFooter(p,data.generatedAt)
 return p.render(options)
}
