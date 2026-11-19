import { Canvas } from "skia-canvas"
import { renderPng } from "@lotus-yunzai/skia"

const width = 860
const pad = 54
const fonts = '"Noto Sans CJK SC", "Microsoft YaHei", sans-serif'
const words = new Intl.Segmenter("zh-Hans", { granularity: "word" })

function wrap(ctx, text, maxWidth, size, weight) {
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

export async function renderMcWikiArticle(article, { mode = process.env.LOTUS_SKIA_MODE ?? "auto" } = {}) {
  const metrics = new Canvas(1, 1)
  metrics.gpu = false
  const measure = metrics.getContext("2d")
  const innerWidth = width - 2 * pad
  const operations = []
  let y = 48
  function add(text, { size, leading, color, weight = "400", x = pad, available = innerWidth }) {
    const lines = wrap(measure, text, available, size, weight)
    operations.push({ lines, x, y, size, leading, color, weight })
    y += lines.length * leading
  }

  add("中文 Minecraft Wiki  /  条目预览", { size: 22, leading: 31, color: "#126148", weight: "700" })
  y += 13
  add(article.title, { size: 48, leading: 66, color: "#172825", weight: "700" })
  y += 21
  if (article.paragraphs.length) {
    add("导语", { size: 20, leading: 30, color: "#126148", weight: "700" })
    for (const text of article.paragraphs) {
      add(text, { size: 24, leading: 38, color: "#263b35" })
      y += 14
    }
  }
  if (article.details.length) {
    y += 12
    add("条目信息", { size: 20, leading: 32, color: "#126148", weight: "700" })
    for (const { label, value } of article.details) {
      add(`${label}  ·  ${value}`, { size: 22, leading: 34, color: "#263b35" })
      y += 7
    }
  }
  y += 28
  const footer = y - 19
  add(`中文 Minecraft Wiki 贡献者 · 修订 ${article.revisionId}`, { size: 19, leading: 29, color: "#40564e" })
  add("正文许可 CC BY-NC-SA 3.0 · 例外见原文", { size: 19, leading: 29, color: "#40564e" })

  return renderPng(width, y + 36, ctx => {
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
