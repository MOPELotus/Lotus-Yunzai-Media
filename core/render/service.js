import { renderPassportQrCard } from "@lotus-yunzai/skia/passport-qr"
import { formatLocalDateTime } from "../time.js"
import { renderSourceCard } from "./source-cards.js"

export async function renderTemplate(template, data, options = {}) {
  const generatedAt = formatLocalDateTime()
  if (template === "qr-login") {
    const prefix = "data:image/png;base64,"
    if (!data.qrDataUrl.startsWith(prefix)) throw new Error("B 站二维码图像不是 PNG。")
    const bytes = Buffer.from(data.qrDataUrl.slice(prefix.length), "base64")
    return (await renderPassportQrCard({ ...data, qrPng: bytes, generatedAt }, {
      mode: options.mode ?? process.env.LOTUS_SKIA_MODE ?? "auto",
    })).png
  }
  return renderSourceCard(template, { ...data, generatedAt }, options)
}

export function renderStatusCard(data, options) {
  return renderTemplate("status", data, options)
}
