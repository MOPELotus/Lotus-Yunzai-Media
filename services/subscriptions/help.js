import { join } from "node:path"
import { FontLibrary, loadImage } from "skia-canvas"
import { renderPng } from "@lotus-yunzai/skia"
import { resolveData, resolveRoot } from "../../core/path.js"

const title = "动态订阅帮助"

function platformSection(platform, account, categories, extra = []) {
  return {
    title: `${platform}动态`,
    rows: [
      { label: `#添加${platform}推送 UID`, value: "主人添加订阅", icon: "diagram" },
      { label: `#删除${platform}推送 UID`, value: "主人删除订阅", icon: "tourbillon_device" },
      { label: `#${platform}全部订阅列表`, value: "主人查看当前机器人的全部订阅", icon: "restaurant_smoothie" },
      { label: `#${platform}订阅列表`, value: "查看本群或私聊的订阅", icon: "archaic_stone" },
      { label: `#执行${platform}任务`, value: "主人手动检查动态", icon: "kamera" },
      { label: `#${platform}${account}UID:UID`, value: "查公开资料", icon: "flower_2" },
      { label: `#${platform}${account}昵称:昵称`, value: "按昵称查询", icon: "shell" },
      { label: "在 UID 前加类别", value: categories },
      ...extra,
    ],
  }
}

const sections = [
  { title: "指令前缀", rows: [
    { label: "#", value: "如 #B站订阅列表", icon: "diagram" },
    { label: "/", value: "如 /微博订阅列表", icon: "diagram" },
  ] },
  platformSection("B站", "UP主", "视频、图文、文章、转发、直播", [
    { label: "B站视频解析", value: "直接发送视频链接", icon: "romaritime_flower" },
  ]),
  platformSection("微博", "博主", "视频、图文、文章、转发"),
]

const assetDirectories = [resolveData("yuki-plugin/resources"), resolveRoot("plugins/yuki-plugin/resources")]
const width = 788, scale = 4

async function legacyImage(relative) {
  for (const directory of assetDirectories) {
    const path = join(directory, relative)
    if (!(await Bun.file(path).exists())) continue
    const image = await loadImage(path).catch(() => undefined)
    if (image) return image
  }
}

async function legacyHelpAssets() {
  const names = [...new Set(sections.flatMap(section => section.rows.map(row => row.icon).filter(Boolean)))]
  const [background, icons] = await Promise.all([
    legacyImage("img/background/Girl.png"),
    Promise.all(names.map(async name => [name, await legacyImage(`img/icon/puplic/${name}.png`)])),
  ])
  for (const directory of assetDirectories) {
    const font = join(directory, "fonts/OPSans.woff2")
    if (!(await Bun.file(font).exists())) continue
    try { FontLibrary.use("MediaSubscriptionHelp", [font]); break }
    catch { /* Use the system CJK font if the old file cannot load. */ }
  }
  return { background, icons:new Map(icons) }
}

let assets

// Three-column card dimensions, color and group order follow the upstream help CSS (MIT).
export async function drawSubscriptionHelp({mode=process.env.LOTUS_SKIA_MODE||"auto"}={}) {
  const {background,icons} = await (assets ??= legacyHelpAssets())
  const groupHeight = section => 26 + Math.ceil(section.rows.length/3)*62
  const height = 148 + sections.reduce((sum,section) => sum + groupHeight(section) + 18, 0)
  return renderPng(Math.round(width*scale), Math.ceil(height*scale), ctx => {
    ctx.scale(scale,scale)
    ctx.fillStyle = "#fff9fd"
    ctx.fillRect(0,0,width,height)
    if (background) ctx.drawImage(background,0,0,width,width*background.height/background.width)

    function box(x,y,w,h,r,fill,border) {
      ctx.beginPath()
      ctx.roundRect(x,y,w,h,r)
      ctx.fillStyle = fill
      ctx.fill()
      ctx.strokeStyle = border
      ctx.stroke()
    }
    function text(value,x,y,size,color,max) {
      ctx.font = `${size}px "MediaSubscriptionHelp", "Noto Sans CJK SC", sans-serif`
      ctx.fillStyle = color
      ctx.textBaseline = "top"
      ctx.fillText(value,x,y,max)
    }

    box(15,15,758,70,10,"rgba(255,250,253,.82)","#ff69b4")
    text("Lotus-Yunzai · 媒体",35,26,22,"#b52c6c",690)
    text(title,35,55,19,"#8b2253",690)
    let y = 108
    for (const section of sections) {
      const h = groupHeight(section)
      box(15,y,758,h,15,"rgba(255,241,255,.45)","#ff69b4")
      box(9,y-10,100,25,12,"#fff1fb","#f29fd2")
      text(section.title,20,y-5,14,"#a62862",80)
      for (const [index,row] of section.rows.entries()) {
        const x = 25 + (index%3)*245, top = y+22+Math.floor(index/3)*62
        box(x,top,235,52,8,"rgba(255,251,255,.90)","#ffb1fa")
        const icon = icons.get(row.icon)
        if (icon) ctx.drawImage(icon,x+7,top+14,24,24)
        const left = icon ? 37 : 9
        text(row.label,x+left,top+8,16,"#1e1f20",226-left)
        text(row.value,x+left,top+30,12,"#102644",226-left)
      }
      y += h+18
    }
    ctx.textAlign = "center"
    text("Lotus-Yunzai",width/2,y+1,14,"#413344",700)
  },mode)
}

export async function renderSubscriptionHelp(render = drawSubscriptionHelp) {
  try {
    const {png} = await render()
    return { type: "image", file:png }
  } catch {
    const text = [title, ...sections.flatMap(({ title, rows }) => [
      "\n" + title,
      ...rows.map(row => `${row.label}　${row.value}`),
    ])].join("\n")
    return { type:"text", text }
  }
}
