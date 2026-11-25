import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { constants } from "node:fs"
import { open, readdir } from "node:fs/promises"
import { join } from "node:path"
import { resolveData } from "../../core/path.ts"

const maxBytes = 2 * 1024 * 1024
const maxNodes = 100
const dateFile = /^nep-\d{12}\.json$/u
const credentialText = /https?:\/\/|\b(?:bearer\s+|(?:set-cookie|cookie|authorization|token|credential|api[_-]?key|SESSDATA|MUSIC_U|MUSIC_A)\s*[:=])/iu

interface PartnerLogReport {
  time?: unknown
  trigger?: unknown
  accounts: unknown[]
}

interface PartnerLogAccount {
  nickname?: unknown
  success?: unknown
  fail?: unknown
  attempts?: unknown
  evaluations?: unknown
}

interface PartnerLogEntry {
  status?: unknown
  name?: unknown
  comment?: unknown
  score?: unknown
  extraScore?: unknown
  attempt?: unknown
  review?: { reason?: unknown }
}

async function readReport(file: string): Promise<PartnerLogReport> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw new Error($t("services.music.partner-log.text_cb93a02045"))
    const bytes = Buffer.allocUnsafe(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const {bytesRead} = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxBytes) throw new Error($t("services.music.partner-log.text_00ffb9f94b"))
    const report: PartnerLogReport | null = JSON.parse(bytes.subarray(0,length).toString("utf8"))
    if (!report || !Array.isArray(report.accounts)) throw new Error($t("services.music.partner-log.text_f7191250c9"))
    return report
  } finally {
    await handle.close()
  }
}

export async function readPartnerLog(directory = resolveData("logs")) {
  try {
    return await readReport(join(directory,"nep-latest.json"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  let entries
  try {
    entries = await readdir(directory,{withFileTypes:true})
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  const name = entries.filter(entry => entry.isFile() && dateFile.test(entry.name)).map(entry => entry.name).sort().at(-1)
  return name ? readReport(join(directory,name)) : null
}

function safeText(value: unknown, limit: number) {
  if (typeof value !== "string" || credentialText.test(value)) return
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "").trim().slice(0,limit).toWellFormed()
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : $t("services.music.partner-log.text_7450cc5b16")
}

function scores(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ""
  const entries: [string, unknown][] = Object.entries(value)
  return entries.slice(0,10).flatMap(([key, score]) =>
    /^[\p{L}\p{N}_-]{1,32}$/u.test(key) && typeof score === "number" && Number.isFinite(score) && score >= 0 ? [`${key}:${score}`] : [],
  ).join(" / ")
}

function songNode(entry: PartnerLogEntry) {
  const completed = entry.status === "already_completed"
  const unknown = entry.status === "unknown"
  const state = entry.status === "success" ? $t("services.music.partner-log.text_053461ce86") : completed ? $t("services.music.partner-log.text_27d8702723") : unknown ? $t("services.music.partner-log.text_e6bedaccc2") : $t("services.music.partner-log.text_28384d7afd")
  const comment = unknown ? $t("services.music.partner-log.text_e6bedaccc2") : safeText(entry.comment,500)
  const reason = entry.review?.reason === "length" ? $t("services.music.partner-log.text_c607283321") :
    entry.review?.reason === "unverified" ? $t("services.music.partner-log.text_98bf9031ae") : ""
  const review = comment || (completed ? $t("services.music.partner-log.text_603b393b59") : reason ? $t("services.music.partner-log.text_72d300d588", { "reason": reason }) : $t("services.music.partner-log.text_926f4d9240"))
  const score = typeof entry.score === "number" && Number.isFinite(entry.score) && entry.score >= 0 ? entry.score : $t("services.music.partner-log.text_e129934bb7")
  return [
    $t("services.music.partner-log.text_8c26608108", { "value1": safeText(entry.name,160) || $t("services.music.partner-log.text_739ed1896d") }),
    $t("services.music.partner-log.text_4d37999770", { "score": score }),
    $t("services.music.partner-log.text_edc9fad143", { "value1": scores(entry.extraScore) || $t("services.music.partner-log.text_007c09e11f") }),
    $t("services.music.partner-log.text_d00ddb619a", { "review": review }),
    $t("services.music.partner-log.text_437880cbec", { "value1": count(entry.attempt), "state": state }),
  ].join("\n")
}

export function partnerLogNodes(report: PartnerLogReport) {
  const title = [$t("services.music.partner-log.text_6163e6ecdd"),safeText(report.time,80),safeText(report.trigger,80)].filter(Boolean).join(" · ")
  const lines = [title]
  for (const row of report.accounts) {
    if (!row || typeof row !== "object") continue
    const account: PartnerLogAccount = row
    if (lines.length > maxNodes) break
    lines.push($t("services.music.partner-log.text_2132ae5adf", { "value1": safeText(account.nickname,100) || $t("services.music.partner-log.text_311bb313fd"), "value2": count(account.success), "value3": count(account.fail), "value4": account.attempts == null ? 1 : count(account.attempts) }))
    const evaluations = Array.isArray(account.evaluations) ? account.evaluations : []
    for (const entry of evaluations) {
      if (!entry || typeof entry !== "object") continue
      if (lines.length > maxNodes) break
      lines.push(songNode(entry))
    }
  }
  if (lines.length > maxNodes) lines.splice(maxNodes-1, 2, $t("services.music.partner-log.text_e3434806a9"))
  return lines.map(text => ({type: "text" as const, text}))
}
