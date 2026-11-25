import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { builtinResourceDirectory } from "../../../../lib/builtin-resources.ts";
import { join } from "node:path"
import { loadImage, type Image } from "skia-canvas"
import { drawInfoText, infoCardColors, measureInfoText, renderInfoCard, type InfoCardOptions } from "@lotus-yunzai/skia/info-card"
import { resolveData, resolveRoot } from "../../core/path.ts"

import type { MessageReply } from "../../../../lib/messages.ts"
import { subscriptionRenderMode } from "./render.ts"

interface HelpRow { label: string; value: string; icon?: string }
interface HelpSection { title: string; rows: HelpRow[] }
interface HelpGroup { title: string; top: number; tiles: HelpTile[] }
interface HelpTile {
  x: number
  top: number
  height: number
  textOffset: number
  label: readonly string[]
  value: readonly string[]
  icon?: Image
}

const title = $t("services.subscriptions.help.text_b423935626")

function platformSection(platform: string, account: string, categories: string, extra: HelpRow[] = []): HelpSection {
  return {
    title: $t("services.subscriptions.help.text_cf520db5d6", { "platform": platform }),
    rows: [
      { label: $t("services.subscriptions.help.text_6925f0523e", { "platform": platform }), value: $t("services.subscriptions.help.text_2c3c9fdf79"), icon: "diagram" },
      { label: $t("services.subscriptions.help.text_a99c06d554", { "platform": platform }), value: $t("services.subscriptions.help.text_bed3fd1a45"), icon: "tourbillon_device" },
      { label: `#${platform}全部订阅列表`, value: $t("services.subscriptions.help.text_a4bbe2ff80"), icon: "restaurant_smoothie" },
      { label: `#${platform}订阅列表`, value: $t("services.subscriptions.help.text_ff151ef8dc"), icon: "archaic_stone" },
      { label: `#执行${platform}任务`, value: $t("services.subscriptions.help.text_54169f1ca5"), icon: "kamera" },
      { label: `#${platform}${account}UID:UID`, value: $t("services.subscriptions.help.text_e2bba80b9b"), icon: "flower_2" },
      { label: `#${platform}${account}昵称:昵称`, value: $t("services.subscriptions.help.text_002db6d3ce"), icon: "shell" },
      { label: $t("services.subscriptions.help.text_69adf6e34c"), value: categories },
      ...extra,
    ],
  }
}

const sections: HelpSection[] = [
  { title: $t("services.subscriptions.help.text_ddb683be18"), rows: [
    { label: "#", value: $t("services.subscriptions.help.text_a610e15d28"), icon: "diagram" },
    { label: "/", value: $t("services.subscriptions.help.text_ec9298aa5a"), icon: "diagram" },
  ] },
  platformSection($t("services.subscriptions.help.text_acfb839ad1"), $t("services.subscriptions.help.text_6b072def69"), $t("services.subscriptions.help.text_a7e6ad6777"), [
    { label: $t("services.subscriptions.help.text_68d25f1b09"), value: $t("services.subscriptions.help.text_207a4d174e"), icon: "romaritime_flower" },
  ]),
  platformSection($t("services.subscriptions.help.text_0fc69798d8"), $t("services.subscriptions.help.text_01d1efbe73"), $t("services.subscriptions.help.text_ec7527ad3d")),
]

const assetDirectories = [resolveData("yuki-plugin/resources"), resolveRoot("plugins/yuki-plugin/resources"), builtinResourceDirectory("social/yuki")]
const width = 788

async function legacyImage(relative: string) {
  for (const directory of assetDirectories) {
    const path = join(directory, relative)
    if (!(await Bun.file(path).exists())) continue
    const image = await loadImage(path).catch(() => undefined)
    if (image) return image
  }
}

async function legacyHelpIcons() {
  const names = [...new Set(sections.flatMap(section => section.rows.map(row => row.icon).filter(name => name !== undefined)))]
  return new Map(await Promise.all(names.map(async name => [name, await legacyImage(`img/icon/puplic/${name}.png`)] as const)))
}

let assets: ReturnType<typeof legacyHelpIcons> | undefined

export async function drawSubscriptionHelp({ mode = subscriptionRenderMode() }: Pick<InfoCardOptions, "mode"> = {}) {
  const icons = await (assets ??= legacyHelpIcons())
  return renderInfoCard({ title, eyebrow: $t("services.subscriptions.help.text_fa33e10009"), width }, layout => {
    const gap = 10
    const tileWidth = Math.floor((layout.width - 2 * gap) / 3)
    const groups: HelpGroup[] = []
    let cursor = layout.y

    for (const section of sections) {
      const group: HelpGroup = { title: section.title, top: cursor, tiles: [] }
      cursor += 36
      for (let index = 0; index < section.rows.length; index += 3) {
        const tiles = section.rows.slice(index, index + 3).map((row, column) => {
          const icon = row.icon ? icons.get(row.icon) : undefined
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

export async function renderSubscriptionHelp(render: () => Promise<{ png: Uint8Array }> = drawSubscriptionHelp): Promise<MessageReply> {
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
