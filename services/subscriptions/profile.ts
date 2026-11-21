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
    ["性别", profile.gender], ["等级", profile.level], ["微博认证", profile.verification],
    ["粉丝数", profile.followers], ["关注数", profile.following],
  ]
  for (const [label, value] of fields) {
    if (value !== undefined && value !== "") lines.push(`${label}：${value}`)
  }
  if (profile.summary) lines.push(Array.from(profile.summary).slice(0, 240).join(""))
  const live = profile.live
  if (live) {
    if (live.title) lines.push(`直播间：${live.title}`)
    if (live.status) lines.push(`直播状态：${live.status}`)
    if (live.viewers !== undefined) lines.push(`观看人数：${live.viewers}`)
    lines.push(`直播链接：https://live.bilibili.com/${live.roomId}`)
  }
  return lines.join("\n")
}
