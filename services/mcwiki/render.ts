import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { Canvas, type CanvasRenderingContext2D } from "skia-canvas"
import { renderPng } from "@lotus-yunzai/skia"
import type { McWikiArticle } from "./article.ts"

type RenderMode = Parameters<typeof renderPng>[3]

interface TextStyle {
  readonly size: number
  readonly leading: number
  readonly color: string
  readonly weight?: string
}

const width = 860
const pad = 54
const fonts = '"Noto Sans CJK SC", "Microsoft YaHei", sans-serif'
const words = new Intl.Segmenter("zh-Hans", { granularity: "word" })

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, size: number, weight: string) {
  ctx.font = `${weight} ${size}px ${fonts}`
  const lines = []
  let line = ""
  for (const { segment } of words.segment(text)) {
    const pieces = ctx.measureText(segment).width > maxWidth ? Array.from(segment) : [segment]
    for (const piece of pieces) {
      if (line && ctx.measureText(line + piece).width > maxWidth) {
        lines.push(line.trimEnd())
        line = ""
      }
      if (line || piece.trim()) line += piece
    }
  }
  if (line) lines.push(line.trimEnd())
  return lines
}

export async function renderMcWikiArticle(article: McWikiArticle, { mode }: { readonly mode?: RenderMode } = {}) {
  const metrics = new Canvas(1, 1)
  metrics.gpu = false
  const measure = metrics.getContext("2d")
  const innerWidth = width - 2 * pad
  const operations: (Required<TextStyle> & { lines: string[]; x: number; y: number })[] = []
  let y = 48
  function add(text: string, { size, leading, color, weight = "400" }: TextStyle) {
    const lines = wrap(measure, text, innerWidth, size, weight)
    operations.push({ lines, x: pad, y, size, leading, color, weight })
    y += lines.length * leading
  }

  add($t("services.mcwiki.render.text_2bbd30b04a"), { size: 22, leading: 31, color: "#126148", weight: "700" })
  y += 13
  add(article.title, { size: 48, leading: 66, color: "#172825", weight: "700" })
  y += 21
  if (article.paragraphs.length) {
    add($t("services.mcwiki.render.text_8cd8068884"), { size: 20, leading: 30, color: "#126148", weight: "700" })
    for (const text of article.paragraphs) {
      add(text, { size: 24, leading: 38, color: "#263b35" })
      y += 14
    }
  }
  if (article.details.length) {
    y += 12
    add($t("services.mcwiki.render.text_cefec2f765"), { size: 20, leading: 32, color: "#126148", weight: "700" })
    for (const { label, value } of article.details) {
      add(`${label}  ·  ${value}`, { size: 22, leading: 34, color: "#263b35" })
      y += 7
    }
  }
  y += 28
  const footer = y - 19
  add($t("services.mcwiki.render.text_357bacecf6", { "revisionId": article.revisionId }), { size: 19, leading: 29, color: "#40564e" })
  add($t("services.mcwiki.render.text_ac85269c74"), { size: 19, leading: 29, color: "#40564e" })

  const configured = process.env.LOTUS_SKIA_MODE
  mode ??= configured === undefined || configured === "auto" ? "auto" : configured === "gpu" ? "gpu" : "cpu"
  const scale = 4
  return renderPng(width * scale, (y + 36) * scale, ctx => {
    ctx.scale(scale, scale)
    ctx.fillStyle = "#f3f7f4"
    ctx.fillRect(0, 0, width, y + 36)
    ctx.fillStyle = "#25775a"
    ctx.fillRect(0, 0, width, 8)
    ctx.fillStyle = "#a8c3b4"
    ctx.fillRect(pad, footer, innerWidth, 1)
    ctx.textBaseline = "top"
    for (const item of operations) {
      ctx.font = `${item.weight} ${item.size}px ${fonts}`
      ctx.fillStyle = item.color
      for (const [index, line] of item.lines.entries()) ctx.fillText(line, item.x, item.y + index * item.leading)
    }
  }, mode)
}
