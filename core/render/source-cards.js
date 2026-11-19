import path from "node:path"
import { Canvas, FontLibrary, loadImage } from "skia-canvas"
import { renderPng } from "@lotus-yunzai/skia"
import { resourcesPath, resolveData } from "../path.js"
import { fetchImageBytes } from "./image.js"
import { plainGameText } from "./plain-text.js"

// Bilibili and Douyin retain the genshin mysNews layout drawn by Lotus-ReFactor.
const GOLD='#d3bc8e',WHITE='#fff'
const TEXT='"SourceMiao", MiSans, sans-serif'
let fontsLoaded=false
const cache=new Map()


const background = path.join(resourcesPath, "miao-theme/bg/bg-hydro.webp")

async function init() {
 if(fontsLoaded)return
 for (const [name, candidates] of [
  ["SourceMiao", [path.join(resourcesPath,"miao-theme/fonts/HYWH-65W.ttf"),resolveData("atlas/theme/fonts/HYWH-65W.ttf")]],
  ["MiSans", [path.join(resourcesPath,"fonts/MiSans-VF.ttf"),resolveData("atlas/theme/fonts/MiSans-VF.ttf")]],
 ]) {
  for (const candidate of candidates) {
   if (await Bun.file(candidate).exists()) { FontLibrary.use(name,[candidate]); break }
  }
 }
 fontsLoaded=true
}

async function getImage(src) {
 if(!src)return null
 if(!cache.has(src)){
  cache.set(src,(async()=>{
   if(src===background){
    return loadImage(background).catch(()=>loadImage(resolveData("atlas/theme/bg/bg-hydro.webp")))
   }
   return loadImage(await fetchImageBytes(src))
  })().catch(()=>{cache.delete(src);return null}))
  if(cache.size>96)cache.delete(cache.keys().next().value)
 }
 return cache.get(src)
}

const damageNumber=n=>Number(n||0).toLocaleString('zh-CN',{maximumFractionDigits:1})

class SourceCanvas{
 constructor(width){this.width=width;this.y=20;this.commands=[];this.refs=new Set();const metrics=new Canvas(1,1);metrics.gpu=false;this.ctx=metrics.getContext('2d')}
 lines(value,width,size=16,font=TEXT){
  this.ctx.font=`${size}px ${font}`
  const lines=[]
  for(const paragraph of plainGameText(value).split(/\r?\n/)){
   let line=''
   for(const token of paragraph.match(/[-+]?\d+(?:\.\d+)?%?|[A-Za-z][A-Za-z0-9.-]*|./gu)||[]){
    if(this.ctx.measureText(token).width<=width){if(line&&this.ctx.measureText(line+token).width>width){lines.push(line);line=''}line+=token}
    else for(const ch of token){if(line&&this.ctx.measureText(line+ch).width>width){lines.push(line);line=''}line+=ch}
   }
   lines.push(line)
  }
  return lines
 }
 rect(x,y,w,h,fill,radius=0){this.commands.push(ctx=>{ctx.fillStyle=fill;ctx.beginPath();ctx.roundRect(x,y,w,h,radius);ctx.fill()})}
 clip(x,y,w,h,radius=10){this.commands.push(ctx=>{ctx.save();ctx.beginPath();ctx.roundRect(x,y,w,h,radius);ctx.clip()})}
 restore(){this.commands.push(ctx=>ctx.restore())}
 rule(x,y,w,color='#ddd'){this.rect(x,y,w,1,color)}
 text(value,x,y,width,size=16,color=WHITE,options={}){
  const font=options.font||TEXT
  let lines
  if(options.singleLine){
   lines=[plainGameText(value).replace(/\s*\n\s*/g,' ')]
   this.ctx.font=`${size}px ${font}`
   while(this.ctx.measureText(lines[0]).width>width&&size>(options.minSize||10)){size-=.5;this.ctx.font=`${size}px ${font}`}
  }else lines=this.lines(value,width,size,font)
  const leading=options.leading||size*1.5
  this.commands.push(ctx=>{ctx.save();ctx.font=`${size}px ${font}`;ctx.textBaseline='top';ctx.fillStyle=color;ctx.textAlign=options.align||'left';if(options.shadow){ctx.shadowColor='#000';ctx.shadowBlur=2;ctx.shadowOffsetX=1;ctx.shadowOffsetY=1}lines.forEach((line,i)=>ctx.fillText(line,x+(options.align==='right'?width:options.align==='center'?width/2:0),y+i*leading));ctx.restore()})
  return lines.length*leading
 }
 image(src,x,y,w,h,options={}){
  if(!src)return
  this.refs.add(src)
  this.commands.push((ctx,images)=>{
   const img=images.get(src);if(!img)return
   ctx.save()
   if(options.radius){ctx.beginPath();ctx.roundRect(x,y,w,h,options.radius);ctx.clip()}
   const ratio=(options.cover?Math.max:Math.min)(w/img.width,h/img.height),dw=img.width*ratio,dh=img.height*ratio
   ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);ctx.restore()
  })
 }
 log(title,rows,lead=''){
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
  contents.forEach((value,i)=>{this.text('•',x+20,y,15,14,WHITE);this.text(value,x+40,y,w-65,14,WHITE,{leading:22});y+=heights[i]})
  this.restore();this.y+=h+10
 }
 async render(options){
  const height=Math.max(240,this.y+50)
  this.height=height
  const configured=Number(options.renderScale??process.env.LOTUS_RENDER_SCALE??4)
  const scale=(720/this.width)*(Number.isFinite(configured)?Math.min(4,Math.max(1,configured)):4)
  const images=new Map()
  await Promise.all([...this.refs].map(async src=>images.set(src,await getImage(src))))
  const rendered=await renderPng(Math.round(this.width*scale),Math.ceil(height*scale),ctx=>{
   ctx.scale(scale,scale)
   ctx.imageSmoothingEnabled=true
   ctx.imageSmoothingQuality='high'
   for(const draw of this.commands)draw(ctx,images)
  },options.mode??process.env.LOTUS_SKIA_MODE??"auto")
  options.onRender?.(rendered.engine)
  return rendered.png
 }
}
function elemental(p){p.rect(0,0,p.width,100000,'#243344');p.commands.push((ctx,images)=>{const img=images.get(background);if(img)ctx.drawImage(img,0,0,p.width,p.height)});p.refs.add(background)}
async function newsImage(p,src){
 if(!src)return
 const img=await getImage(src)
 if(!img){p.image(src,30,p.y,p.width-60,200);p.y+=215;return}
 const w=p.width-60,h=Math.min(3200,w*img.height/img.width)
 p.image(src,30,p.y,w,h,{radius:14});p.y+=h+20
}
function mediaStats(data,template){
 const s=data.stat||{},format=n=>n===undefined?'未记录':damageNumber(n)
 const stats=data.type==='live'?[['直播状态',data.liveStatus],['在线人数',format(data.online)]]:[['点赞',format(s.like)],['评论',format(s.reply)],['收藏',format(s.favorite)],...(template==='bilibili-info'?[['投币',format(s.coin)],['播放',format(s.view)],['弹幕',format(s.danmaku)]]:[['分享',format(s.share)]])]
 return stats.map(([label,value])=>`${label} ${value||'未记录'}`).join('    ')
}
async function news(p,data,template){
 // genshin mysNews content order inside Miao help/index's elemental, rounded
 // group container. Keep the article typography and real cover/media content.
 elemental(p)
 const frame={height:0}
 p.commands.push(ctx=>{ctx.fillStyle='rgba(15,20,31,.78)';ctx.beginPath();ctx.roundRect(15,20,p.width-30,frame.height,15);ctx.fill()})
 p.y=40
 const owner=data.owner||'作者资料未记录'
 if(data.avatar)p.image(data.avatar,35,p.y,90,90,{cover:true,radius:45})
 p.text(owner,data.avatar?143:35,p.y+16,p.width-(data.avatar?178:70),30,GOLD,{leading:50})
 p.text(template==='douyin-article'?`第 ${data.page||1} 页`:data.id||'',data.avatar?143:35,p.y+66,p.width-(data.avatar?178:70),22,'#c2c5cb')
 p.y+=130
 p.rule(30,p.y-5,p.width-60,'rgba(211,188,142,.35)')
 p.y+=p.text(data.title||'作品信息',30,p.y,p.width-60,44,WHITE,{leading:60})+20
 if(template==='douyin-article'){
  for(const block of data.blocks||[]){
   if(block.type==='image')for(const src of block.urls||[])await newsImage(p,src)
   else if(block.text)p.y+=p.text(block.text,30,p.y,p.width-60,22,WHITE,{leading:36})+16
  }
 }else{
  const metadata=[data.type==='live'?'直播':data.type==='gallery'?'图集':data.type==='live_photo'?'动态图片':data.type==='article'?'文章':'视频',data.duration?`${Math.floor(data.duration/60)}分${Math.floor(data.duration%60)}秒`:'',data.createdAt?new Date(data.createdAt*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'',data.media?.length?`${data.media.length} 个媒体项`:''].filter(Boolean).join(' · ')
  p.y+=p.text(metadata,30,p.y,p.width-60,18,GOLD,{leading:28})+20
  await newsImage(p,data.cover||data.image)
  if(data.desc)p.y+=p.text(data.desc,30,p.y,p.width-60,22,WHITE,{leading:36})+20
  if(data.music?.title)p.y+=p.text(`音乐：${data.music.title} · ${data.music.author||''}`,30,p.y,p.width-60,18,'#c2c5cb')+20
  if(data.collection?.title)p.y+=p.text(`合集：${data.collection.title}`,30,p.y,p.width-60,18,'#c2c5cb')+20
  if(data.sources?.length)p.y+=p.text(`可用视频源：${data.sources.map(source=>[source.quality||'清晰度未记录',source.width&&source.height?`${source.width}×${source.height}`:'',source.codec||''].filter(Boolean).join(' ')).join(' / ')}`,30,p.y,p.width-60,18,'#c2c5cb')+20
  for(const warning of data.warnings||[])p.y+=p.text(warning,30,p.y,p.width-60,18,'#c2c5cb')+16
  p.rule(30,p.y,p.width-60,'rgba(211,188,142,.35)');p.y+=22
  p.y+=p.text(mediaStats(data,template),30,p.y,p.width-60,18,GOLD,{leading:28})+18
 }
 frame.height=p.y-10;p.y+=15
}

export async function renderSourceCard(template,data={},options={}){
 await init()
 const p=new SourceCanvas(template==="status"?600:900)
 if(template==="status"){
  elemental(p)
  p.log(data.title||'荷花插件',data.items||[],[data.subtitle,data.message].filter(Boolean).join('\n'))
 }else{
  await news(p,data,template)
 }
 p.text(`荷花插件${data.generatedAt?' · '+data.generatedAt:''}`,15,p.y+15,p.width-30,12,WHITE,{align:'center',shadow:true,leading:18})
 return p.render(options)
}
