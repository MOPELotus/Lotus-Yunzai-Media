import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as pause } from "node:timers/promises"
import YAML from "yaml"
import { lockFile } from "../../../../lib/file-lock.ts"
import { legacyLotusDirectories } from "../../../../lib/lotus-global-config.ts"
import { resolveData, resolveRoot } from "../../core/path.ts"
import { formatLocalIso } from "../../core/time.ts"
import { TuneWeaveService, type TuneWeaveConfig } from "../tuneweave/service.ts"
import type { TuneWeaveQrProfile } from "../tuneweave/auth.ts"
import { NeteasePartnerAccounts, type PartnerAccount } from "./partner-account.ts"
import { collectReviewContext, PartnerReviewService, type ReviewConfig, type ReviewWork } from "./partner-review.ts"

const goal = 20
const routes = {
  daily: "/api/music/partner/daily/task/get",
  extra: "/api/music/partner/extra/wait/evaluate/work/list",
  evaluate: "/api/music/partner/work/evaluate",
}
const accountId = /^[1-9]\d{0,19}$/u
const workId = /^[\p{L}\p{N}_-]{1,64}$/u

export interface PartnerConfig {
  enable?: boolean
  auto_catch_up?: boolean
  notify_master?: boolean
  schedule?: unknown
  login_timeout_ms?: number
  login_poll_ms?: number
  delay_ms_min?: number
  delay_ms_max?: number
  comments?: unknown[]
  review?: ReviewConfig
}

type ReceiptStatus = "pending" | "confirmed"
type PartnerState = {
  last_run_date?: string
  last_run_time?: string
  evaluation_date?: string
  evaluation_receipts?: [string, ReceiptStatus][]
}

type WorkDimension = string | number | { id?: unknown; dimensionId?: unknown; key?: unknown; name?: unknown } | null
type Work = ReviewWork & { supportExtraEvaTypes?: Record<string, WorkDimension>; dimensions?: Record<string, WorkDimension> }
type WorkItem = Work & { work?: Work; completed?: boolean; score?: number | null; extraScore?: Record<string, number | null>;
  comment?: string; isExtra?: boolean }
type Query = <T>(uri: string, data?: Record<string, unknown>) => Promise<T>
type DailyResult = { code?: number; data?: { id?: string | number; works?: WorkItem[] } }
type ExtraResult = { code?: number; data?: WorkItem[] }
type EvaluationResult = { code?: number }
type EvaluationPayload = {
  taskId?: string | number
  workId: string | number
  score: number
  tags: string
  customTags: string
  comment: string
  syncYunCircle: "true"
  syncComment: "true" | "false"
  extraScore: string
  source: "mp-music-partner"
  extraResource?: "true"
}
type Evaluation = {
  workId: string
  name: string
  dimensions: string[]
  status: "already_completed" | "unknown" | "success" | "failed"
  score?: number | null
  extraScore?: Record<string, number | null>
  comment?: string
  commentPosted?: boolean
  attempt: number
}
type AccountSummary = {
  uid?: string
  nickname: string
  total: number
  success: number
  skip: number
  fail: number
  attempts: number
  details: string[]
  evaluations: Evaluation[]
  results?: Evaluation[]
}
export type PartnerReport = { trigger: string; time: string; accounts: AccountSummary[] }
type Checkpoint = (receipt: string, status?: ReceiptStatus) => Promise<void>

interface PartnerTaskOptions {
  tuneweave?: Pick<TuneWeaveService, "request" | "requireReady">
  tuneweaveConfig?: Partial<TuneWeaveConfig>
  accounts?: Pick<NeteasePartnerAccounts, "loadAccounts" | "saveAccount">
  stateFile?: string
  legacyStateFiles?: string[]
  logDir?: string
  reviewer?: Pick<PartnerReviewService, "generate">
  scorer?: () => number
  now?: () => Date
  sleep?: (delay: number, signal?: AbortSignal) => Promise<void>
}

async function atomicWrite(filename: string, data: string) {
  await fs.mkdir(path.dirname(filename), { recursive:true, mode:0o700 })
  const file = `${filename}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(file, "wx", 0o600)
    try { await handle.writeFile(data); await handle.sync() }
    finally { await handle.close() }
    await fs.rename(file, filename)
  } finally { await fs.rm(file, { force:true }) }
}

async function readState(file: string): Promise<PartnerState | undefined> {
  try {
    const state = YAML.parse(await fs.readFile(file, "utf8")) ?? {}
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("合伙人任务状态格式无效")
    return state
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
}

// Preserve the score distribution and optional work dimensions from Lotus-ReFactor e28c6df.
function weightedScore() {
  const roll = Math.floor(Math.random() * 100)
  if (roll < 35) return 3
  if (roll < 70) return 4
  if (roll < 90) return 2
  return 5
}

function dimensionsFor(item: WorkItem, work: Work) {
  function ids(field: "supportExtraEvaTypes" | "dimensions") {
    const ids = new Set<string>()
    for (const source of [work,item]) {
      const values = source[field]
      if (!values || typeof values !== "object") continue
      for (const value of Object.values(values)) {
        const id = typeof value === "object" ? value?.id ?? value?.dimensionId ?? value?.key ?? value?.name : value
        if (id !== undefined && /^[\p{L}\p{N}_-]{1,32}$/u.test(String(id))) ids.add(String(id))
      }
    }
    return [...ids]
  }
  const current = ids("supportExtraEvaTypes")
  return current.length ? current : ids("dimensions")
}

function bounded(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback
}

function delayFor(config: PartnerConfig) {
  const low = bounded(config.delay_ms_min, 8000, 0, 300000)
  const high = bounded(config.delay_ms_max, 11000, 0, 300000)
  if (high === 0) return 0
  return high <= low ? low : low + Math.floor(Math.random() * (high - low + 1))
}

export class NeteasePartnerTask {
  private readonly tuneweave: NonNullable<PartnerTaskOptions["tuneweave"]>
  private readonly accounts: NonNullable<PartnerTaskOptions["accounts"]>
  private readonly stateFile: string
  private readonly legacyStateFiles: string[]
  private readonly logDir: string
  private readonly reviewer: NonNullable<PartnerTaskOptions["reviewer"]>
  private readonly scorer: () => number
  private readonly now: () => Date
  private readonly sleep: NonNullable<PartnerTaskOptions["sleep"]>

  constructor({ tuneweave, tuneweaveConfig, accounts, stateFile, legacyStateFiles, logDir, reviewer, scorer, now, sleep }: PartnerTaskOptions = {}) {
    this.tuneweave = tuneweave ?? new TuneWeaveService({ config:tuneweaveConfig })
    this.accounts = accounts ?? new NeteasePartnerAccounts()
    this.stateFile = stateFile ?? resolveData("netease", "state.yaml")
    this.legacyStateFiles = legacyStateFiles ?? (stateFile ? [] :
      legacyLotusDirectories.map(id => resolveRoot("plugins", id, "data", "netease", "state.yaml")))
    this.logDir = logDir ?? resolveData("logs")
    this.reviewer = reviewer ?? new PartnerReviewService()
    this.scorer = scorer ?? weightedScore
    this.now = now ?? (() => new Date())
    this.sleep = sleep ?? ((delay, signal) => pause(delay, undefined, { signal }))
  }

  async state() {
    const current = await readState(this.stateFile)
    if (current !== undefined) return current
    const previous = (await Promise.all(this.legacyStateFiles.map(readState))).filter((entry): entry is PartnerState => Boolean(entry?.last_run_date))
    const dates = new Set(previous.map(entry => entry.last_run_date))
    if (dates.size > 1) throw new Error("两处旧合伙人任务记录不一致")
    const [legacy] = previous
    return legacy ? { last_run_date:legacy.last_run_date, last_run_time:legacy.last_run_time } : {}
  }

  async hasRunToday() {
    return (await this.state()).last_run_date === formatLocalIso(this.now()).slice(0,10)
  }

  async execute(config: PartnerConfig = {}, trigger = "手动执行",
    { signal, once = false }: { signal?: AbortSignal; once?: boolean } = {}): Promise<PartnerReport | { skipped: true; reason: "already_run_today" }> {
    if (signal?.aborted) signal.throwIfAborted()
    await fs.mkdir(path.dirname(this.stateFile), { recursive:true, mode:0o700 })
    const lock = await lockFile(this.stateFile + ".lock", "网易云合伙人任务")
    try {
      signal?.throwIfAborted()
      const time = formatLocalIso(this.now())
      const date = time.slice(0,10)
      const state = await this.state()
      if (once && state.last_run_date === date) return { skipped:true, reason:"already_run_today" }

      const saved = state.evaluation_date === date && Array.isArray(state.evaluation_receipts)
        ? state.evaluation_receipts.filter(row => Array.isArray(row) && typeof row[0] === "string" &&
          (row[1] === "pending" || row[1] === "confirmed"))
        : []
      const journal = new Map(saved)
      const checkpoint: Checkpoint = async (receipt, status) => {
        if (status) journal.set(receipt, status)
        else journal.delete(receipt)
        await atomicWrite(this.stateFile, YAML.stringify({
          ...state, evaluation_date:date, evaluation_receipts:[...journal],
        }))
      }

      const accounts = await this.accounts.loadAccounts()
      const report: PartnerReport = { trigger, time, accounts:[] }
      if (!accounts.length) report.accounts.push({
        nickname:"未配置账号", total:0, success:0, skip:0, fail:0, attempts:0, details:["请使用 #合伙人登录。"], evaluations:[],
      })
      for (const account of accounts) {
        signal?.throwIfAborted()
        report.accounts.push(await this.evaluateAccount(account, config, journal, checkpoint, signal))
      }
      signal?.throwIfAborted()
      await atomicWrite(path.join(this.logDir,"nep-latest.json"), JSON.stringify(report, null, 2))
      await atomicWrite(this.stateFile, YAML.stringify({
        ...state, evaluation_date:date, evaluation_receipts:[...journal], last_run_date:date, last_run_time:time,
      }))
      return report
    } finally { lock.close() }
  }

  async identity(account: PartnerAccount, signal?: AbortSignal) {
    const uid = String(account?.uid ?? "")
    const alias = account?.tuneweave_account || (account?.cookie ? "default" : "")
    if (!accountId.test(uid) || typeof alias !== "string" || !alias || alias.length > 150) {
      throw new Error("未配置可核验的账号，请使用 #合伙人登录")
    }
    const profile = await this.tuneweave.request<TuneWeaveQrProfile>("/v1/account?" + new URLSearchParams({ platform:"netease", account:alias }), { signal })
    if (profile?.authenticated !== true || String(profile.user_id) !== uid) {
      throw new Error("TuneWeave 账号与合伙人记录不一致，请重新登录")
    }
    if (account.tuneweave_account) return alias
    const updated = await this.accounts.saveAccount({ ...account, uid, tuneweave_account:alias }, { onlyIfLegacy:true, signal })
    if (updated?.tuneweave_account !== alias) throw new Error("账号关联已更新，请重试")
    return alias
  }

  async evaluateAccount(account: PartnerAccount, config: PartnerConfig, journal: ReadonlyMap<string, ReceiptStatus>, checkpoint: Checkpoint, signal?: AbortSignal) {
    const uid = String(account?.uid || "")
    const nickname = typeof account?.nickname === "string" ? account.nickname.slice(0,100).toWellFormed() : "网易云账号"
    const summary: AccountSummary = { uid, nickname, total:goal, success:0, skip:0, fail:goal, attempts:0, details:[], evaluations:[], results:[] }
    const completed = new Map<string, Evaluation>(), unknown = new Set<string>(), payloads = new Map<string, EvaluationPayload>()
    const comments = Array.isArray(config.comments) && config.comments.length ? config.comments : ["打卡支持"]
    const pool = [...new Set(comments.filter(value => typeof value === "string").map(value => value.trim()).filter(Boolean))]
    let available = [...pool]

    for (let attempt = 1; attempt <= 2 && completed.size < goal; attempt++) {
      signal?.throwIfAborted()
      summary.attempts = attempt
      if (attempt > 1) await this.sleep(delayFor(config), signal)
      let works: WorkItem[], daily: DailyResult, query: Query
      try {
        await this.tuneweave.requireReady("netease", signal)
        const alias = await this.identity(account, signal)
        query = <T>(uri: string, data: Record<string, unknown> = {}) => this.tuneweave.request<T>("/v1/extensions/netease/api", {
          method:"POST", body:{ account:alias, uri, data, crypto:"weapi" }, signal,
        })
        daily = await query<DailyResult>(routes.daily)
        if (daily?.code !== 200) {
          summary.details.push("每日任务读取失败。")
          continue
        }
        works = Array.isArray(daily.data?.works) ? [...daily.data.works] : []
        try {
          const extra = await query<ExtraResult>(routes.extra)
          if (extra?.code === 200 && Array.isArray(extra.data)) {
            const limit = bounded(Number(account.extraCount ?? 15), 15, 0, Number.MAX_SAFE_INTEGER)
            works.push(...extra.data.slice(0, Math.min(15,limit)).map(item => ({ ...item, isExtra:true })))
          }
        } catch {
          signal?.throwIfAborted()
          summary.details.push("额外任务读取失败。")
        }
      } catch {
        signal?.throwIfAborted()
        summary.details.push("无法核实登录账号或连接 TuneWeave，请用 #TuneWeave状态 检查。")
        continue
      }
      if (!works.length) summary.details.push("没有待评作品。")

      const seen = new Set()
      for (const item of works) {
        signal?.throwIfAborted()
        if (completed.size >= goal) break
        const work = item?.work || item
        const rawId = work?.id
        if (typeof rawId !== "string" && (typeof rawId !== "number" || !Number.isSafeInteger(rawId))) continue
        const id = String(rawId)
        if (!workId.test(id) || completed.has(id) || seen.has(id)) continue
        seen.add(id)
        const name = typeof work.name === "string" ? work.name.slice(0,160).toWellFormed() : id
        const dimensions = dimensionsFor(item, work)
        const receipt = uid + ":" + id
        if (item.completed || journal.get(receipt) === "confirmed") {
          const record: Evaluation = { workId:id, name, dimensions, status:"already_completed", score:item.score ?? null,
            extraScore:Object.fromEntries(dimensions.map(key => [key,item.extraScore?.[key] ?? null])), comment:item.comment || "", attempt }
          completed.set(id, record)
          summary.evaluations.push(record)
          summary.skip++
          if (journal.get(receipt) !== "confirmed") await checkpoint(receipt, "confirmed")
          continue
        }
        if (journal.has(receipt)) {
          if (!unknown.has(id)) summary.evaluations.push({ workId:id, name, dimensions, attempt, status:"unknown" })
          unknown.add(id)
          continue
        }

        let payload = payloads.get(id)
        if (!payload) {
          let comment = ""
          const score = this.scorer()
          const extraScore = Object.fromEntries(dimensions.map(key => [key,this.scorer()]))
          if (account.comment !== false) {
            const review = config.review ?? {}
            const max = bounded(review.max_chars,140,20,500)
            if (review.mode === "responses" || review.mode === "codex") {
              try {
                const result = await this.reviewer.generate(await collectReviewContext(work, query), { ...review, max_chars:max }, signal)
                comment = result.comment
              } catch {
                signal?.throwIfAborted()
                summary.details.push("乐评未核实，本首仅提交评分。")
              }
            } else if (!review.mode || review.mode === "fixed") {
              if (!available.length) available = [...pool]
              const picked = available.splice(Math.floor(Math.random() * available.length), 1)[0] || ""
              if (picked.length <= max) comment = picked
            }
          }
          payload = { taskId:daily.data?.id, workId:rawId, score, tags:`${score}-A-1`, customTags:"[]", comment, syncYunCircle:"true",
            syncComment:comment ? "true" : "false", extraScore:JSON.stringify(extraScore), source:"mp-music-partner",
            ...(item.isExtra ? { extraResource:"true" } : {}) }
          payloads.set(id, payload)
        }
        await this.sleep(delayFor(config), signal)
        signal?.throwIfAborted()
        await checkpoint(receipt, "pending")
        if (signal?.aborted) {
          await checkpoint(receipt)
          signal.throwIfAborted()
        }
        const record: Evaluation = { workId:id, name, score:payload.score, extraScore:JSON.parse(payload.extraScore), dimensions,
          comment:payload.comment, commentPosted:false, attempt, status:"unknown" }
        let outcome: EvaluationResult | undefined
        try { outcome = await query<EvaluationResult>(routes.evaluate, payload) }
        catch (error) {
          signal?.throwIfAborted()
          if ((error as { upstreamCode?: number }).upstreamCode === 405) outcome = { code:405 }
        }
        if (outcome?.code === 200) {
          await checkpoint(receipt, "confirmed")
          record.status = "success"
          record.commentPosted = Boolean(payload.comment)
          completed.set(id, record)
        } else if (outcome?.code === 405) {
          await checkpoint(receipt)
          record.status = "failed"
        } else {
          unknown.add(id)
        }
        summary.evaluations.push(record)
        if (outcome?.code === 405) {
          summary.details.push("网易云今日没有更多可评定歌曲（405）。")
          break
        }
      }
    }
    summary.success = completed.size
    summary.fail = goal - completed.size
    summary.results = [...completed.values()]
    return summary
  }
}
