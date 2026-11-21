import { renderPassportQrCard, type PassportQrCardModel } from "@lotus-yunzai/skia/passport-qr"
import { formatLocalDateTime } from "../time.ts"
import { renderMode, renderSourceCard, type SourceTemplate, type SourceCard, type RenderOptions } from "./source-cards.ts"

type QrCard = Omit<PassportQrCardModel, "qrPng"> & { readonly qrDataUrl: string }

export function renderTemplate(template: "qr-login", data: QrCard, options?: RenderOptions): Promise<Buffer>
export function renderTemplate(template: SourceTemplate, data: SourceCard, options?: RenderOptions): Promise<Buffer>
export async function renderTemplate(template: "qr-login" | SourceTemplate, data: QrCard | SourceCard, options: RenderOptions = {}) {
  const generatedAt = formatLocalDateTime()
  if (template === "qr-login") {
    const prefix = "data:image/png;base64,"
    if (!("qrDataUrl" in data) || !data.qrDataUrl.startsWith(prefix)) throw new Error("B 站二维码图像不是 PNG。")
    const bytes = Buffer.from(data.qrDataUrl.slice(prefix.length), "base64")
    return (await renderPassportQrCard({ ...data, qrPng: bytes, generatedAt }, {
      mode: options.mode ?? renderMode(),
    })).png
  }
  return renderSourceCard(template, { ...data, generatedAt }, options)
}

export function renderStatusCard(data: SourceCard, options?: RenderOptions) {
  return renderTemplate("status", data, options)
}
