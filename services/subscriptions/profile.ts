import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import type { SubscriptionProfile } from "./types.ts"

export function publicCount(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value !== "string") return
  const text = value.trim()
  if (/^(?:\d{1,20}|\d{1,12}(?:\.\d{1,3})?[万亿]\+?)$/u.test(text)) return text
}

export function profileText(profile: SubscriptionProfile) {
  const lines = [`${profile.name} · UID ${profile.uid}`]
  const fields = [
    [$t("services.subscriptions.profile.text_a752a7d8c1"), profile.gender], [$t("services.subscriptions.profile.text_3377171738"), profile.level], [$t("services.subscriptions.profile.text_0c74b9165f"), profile.verification],
    [$t("services.subscriptions.profile.text_4032a00e50"), profile.followers], [$t("services.subscriptions.profile.text_e503e66c57"), profile.following],
  ]
  for (const [label, value] of fields) {
    if (value !== undefined && value !== "") lines.push(`${label}：${value}`)
  }
  if (profile.summary) lines.push(Array.from(profile.summary).slice(0, 240).join(""))
  const live = profile.live
  if (live) {
    if (live.title) lines.push($t("services.subscriptions.profile.text_60b8cc21f8", { "title": live.title }))
    if (live.status) lines.push($t("services.subscriptions.profile.text_84298e8420", { "status": live.status }))
    if (live.viewers !== undefined) lines.push($t("services.subscriptions.profile.text_e1e2165408", { "viewers": live.viewers }))
    lines.push($t("services.subscriptions.profile.text_329159b152", { "roomId": live.roomId }))
  }
  return lines.join("\n")
}
