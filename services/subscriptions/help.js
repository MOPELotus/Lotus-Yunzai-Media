import { join } from "node:path"
import { loadImage } from "skia-canvas"
import { drawInfoText, infoCardColors, measureInfoText, renderInfoCard } from "@lotus-yunzai/skia/info-card"
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
const width = 788

async function legacyImage(relative) {
  for (const directory of assetDirectories) {
    const path = join(directory, relative)
    if (!(await Bun.file(path).exists())) continue
    const image = await loadImage(path).catch(() => undefined)
    if (image) return image
  }
}

async function legacyHelpIcons() {
  const names = [...new Set(sections.flatMap(section => section.rows.map(row => row.icon).filter(Boolean)))]
  return new Map(await Promise.all(names.map(async name => [name, await legacyImage(`img/icon/puplic/${name}.png`)])))
}

let assets

export async function drawSubscriptionHelp({ mode = process.env.LOTUS_SKIA_MODE || "auto" } = {}) {
  const icons = await (assets ??= legacyHelpIcons())
  return renderInfoCard({ title, eyebrow: "媒体", width }, layout => {
    const gap = 10
    const tileWidth = Math.floor((layout.width - 2 * gap) / 3)
    const groups = []
    let cursor = layout.y

    for (const section of sections) {
      const group = { title: section.title, top: cursor, tiles: [] }
      cursor += 36
      for (let index = 0; index < section.rows.length; index += 3) {
        const tiles = section.rows.slice(index, index + 3).map((row, column) => {
          const icon = icons.get(row.icon)
          const textOffset = icon ? 38 : 10
          const textWidth = tileWidth - textOffset - 10
          const label = measureInfoText(layout.measure, row.label, textWidth, 16)
          const value = measureInfoText(layout.measure, row.value, textWidth, 13)
          return { x: layout.x + column * (tileWidth + gap), top: cursor, textOffset, label, value, icon }
        })
        const height = Math.max(...tiles.map(tile => tile.label.length * 21 + tile.value.length * 17 + 20))
        group.tiles.push(...tiles.map(tile => ({ ...tile, height })))
        cursor += height + gap
      }
      cursor += 16
      groups.push(group)
    }

    return { height: cursor - layout.y, draw(ctx) {
      for (const group of groups) {
        drawInfoText(ctx, [group.title], layout.x, group.top, { size: 19, color: infoCardColors.gold })
        for (const tile of group.tiles) {
          ctx.fillStyle = infoCardColors.tile
          ctx.beginPath()
          ctx.roundRect(tile.x, tile.top, tileWidth, tile.height, 8)
          ctx.fill()
          if (tile.icon) ctx.drawImage(tile.icon, tile.x + 8, tile.top + 11, 22, 22)
          const textX = tile.x + tile.textOffset
          drawInfoText(ctx, tile.label, textX, tile.top + 8, { size: 16, leading: 21 })
          drawInfoText(ctx, tile.value, textX, tile.top + 10 + tile.label.length * 21, {
            size: 13, leading: 17, color: infoCardColors.muted,
          })
        }
      }
    } }
  }, { mode, scale: 4, allowHalfScale: false })
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
