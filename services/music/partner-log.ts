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
}

async function readReport(file: string): Promise<PartnerLogReport> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("无效的合伙人日志文件")
    const bytes = Buffer.allocUnsafe(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const {bytesRead} = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxBytes) throw new Error("合伙人日志超出读取上限")
    const report: PartnerLogReport | null = JSON.parse(bytes.subarray(0,length).toString("utf8"))
    if (!report || !Array.isArray(report.accounts)) throw new Error("合伙人日志格式无效")
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
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "未记录"
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
  const state = entry.status === "success" ? "成功" : completed ? "此前已完成" : unknown ? "结果未确认" : "失败"
  const comment = unknown ? "结果未确认" : safeText(entry.comment,500)
  const score = typeof entry.score === "number" && Number.isFinite(entry.score) && entry.score >= 0 ? entry.score : "未返回"
  return [
    `歌曲：${safeText(entry.name,160) || "曲目"}`,
    `主分：${score}`,
    `子项：${scores(entry.extraScore) || "该作品未提供子项"}`,
    `乐评：${comment || (completed ? "已完成记录未返回乐评" : "未发布")}`,
    `第 ${count(entry.attempt)} 轮 · ${state}`,
  ].join("\n")
}

export function partnerLogNodes(report: PartnerLogReport) {
  const title = ["合伙人日志",safeText(report.time,80),safeText(report.trigger,80)].filter(Boolean).join(" · ")
  const lines = [title]
  for (const row of report.accounts) {
    if (!row || typeof row !== "object") continue
    const account: PartnerLogAccount = row
    if (lines.length > maxNodes) break
    lines.push(`${safeText(account.nickname,100) || "账号"}：成功 ${count(account.success)} · 失败 ${count(account.fail)} · 执行 ${account.attempts == null ? 1 : count(account.attempts)} 轮`)
    const evaluations = Array.isArray(account.evaluations) ? account.evaluations : []
    for (const entry of evaluations) {
      if (!entry || typeof entry !== "object") continue
      if (lines.length > maxNodes) break
      lines.push(songNode(entry))
    }
  }
  if (lines.length > maxNodes) lines.splice(maxNodes-1, 2, "日志较长，仅显示前 99 条。")
  return lines.map(text => ({type: "text" as const, text}))
}
