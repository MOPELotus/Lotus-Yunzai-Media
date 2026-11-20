import { join } from "node:path"
import QRCode from "qrcode"
import { FontLibrary } from "skia-canvas"
import { renderPng } from "@lotus-yunzai/skia"
import { resolveData, resolveRoot } from "../../../core/path.js"

let font = "sans-serif"
let fontLoaded

async function loadFont() {
  for (const file of [resolveData("yuki-plugin/resources/fonts/OPSans.woff2"),
    resolveRoot(join("plugins", "yuki-plugin", "resources", "fonts", "OPSans.woff2"))]) {
    if (await Bun.file(file).exists()) {
      const families = FontLibrary.use("MediaSubscriptionLogin", [file])
      if (families) font = '"MediaSubscriptionLogin", sans-serif'
      return
    }
  }
}

export async function renderBiliSubscriptionLogin(url) {
  const matrix = QRCode.create(url, { errorCorrectionLevel: "M" }).modules
  await (fontLoaded ??= loadFont().catch(() => undefined))
  const width = 463, height = 462
  const scale = 2
  const configured = process.env.LOTUS_SKIA_MODE
  const mode = configured === "gpu" || configured === "cpu" ? configured : "auto"
  const { png } = await renderPng(width * scale, height * scale, (ctx) => {
    ctx.scale(scale, scale)
    ctx.fillStyle = "#fff"
    ctx.fillRect(0, 0, width, height)
    ctx.beginPath()
    ctx.roundRect(21, 20, 421, 422, 8)
    ctx.shadowBlur = 12
    ctx.shadowColor = "rgba(246, 140, 224, .28)"
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.strokeStyle = "#ff69b4"
    ctx.stroke()
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.font = `18px ${font}`
    ctx.fillStyle = "#3b82f6"
    ctx.fillText("B站动态订阅扫码登录", width / 2, 56)
    ctx.beginPath()
    ctx.roundRect(87.5, 83.5, 288, 288, 8)
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = "#fb8bc3"
    ctx.stroke()
    ctx.setLineDash([])
    const module = Math.floor(288 / (matrix.size + 8))
    const x = Math.floor((width - matrix.size * module) / 2)
    const y = Math.floor(84 + (288 - matrix.size * module) / 2)
    ctx.fillStyle = "#000"
    for (let row = 0; row < matrix.size; row++) {
      for (let col = 0; col < matrix.size; col++) {
        if (matrix.get(row, col)) ctx.fillRect(x + col * module, y + row * module, module, module)
      }
    }
    ctx.fillStyle = "#dc2626"
    ctx.fillText("请在 3 分钟内使用哔哩哔哩 App 确认", width / 2, 405)
  }, mode)
  return png
}
