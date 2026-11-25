import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export interface ReviewConfig {
  mode?: string
  max_chars?: number
  api_key?: string
  api_url?: string
  model?: string
  timeout_ms?: number
  codex_command?: string
}

type SongId = string | number
type Artist = { id?: SongId; name?: unknown }
type Song = { id?: SongId; name?: unknown; ar?: Artist[]; artists?: Artist[]; al?: { name?: unknown };
  album?: { name?: unknown }; description?: unknown; tags?: unknown }

export interface ReviewWork {
  id?: SongId
  song?: Song
  songInfo?: Song
  music?: Song
  resourceId?: SongId
  songId?: SongId
  musicId?: SongId
  lyricContent?: unknown
  artists?: Artist[]
  artistList?: Artist[]
  name?: unknown
  authorName?: unknown
  description?: unknown
  desc?: unknown
  style?: unknown
  tags?: unknown
}

type ReviewApi = (uri: string, data: Record<string, string | number>) => Promise<{
  songs?: Song[]
  lrc?: { lyric?: unknown }
  briefDesc?: unknown
}>

type ReviewContext = Awaited<ReturnType<typeof collectReviewContext>>
type ReviewOutput = { comment?: unknown; sources?: unknown }
type SearchSource = { url?: unknown; type?: unknown }
type ResponseOutput = { type?: string; status?: string; action?: { sources?: SearchSource[] };
  content?: { type?: string; text?: string; annotations?: SearchSource[] }[] }

interface ReviewServiceOptions {
  fetch?: (input: URL, init: RequestInit) => Promise<Response>
  spawnProcess?: (command: string, args: string[], options: {
    cwd: string
    detached: boolean
    stdio: ["pipe", "pipe", "pipe"]
    shell: false
  }) => ChildProcessWithoutNullStreams
}

// Review collection and schema from Lotus-ReFactor e28c6df.
const text = (value: unknown, limit = 4000) => String(value || "").replace(/<[^>]*>/g, "").slice(0, limit)
const names = (values: unknown) => (Array.isArray(values) ? values : []).map(value => text(typeof value === "string" || typeof value === "number" ? value : value?.name, 100)).filter(Boolean)
const schema = {
  type: "object", additionalProperties: false,
  properties: { comment: { type: "string" }, sources: { type: "array", items: { type: "string" } } },
  required: ["comment", "sources"],
}

export async function collectReviewContext(work: ReviewWork, api: ReviewApi) {
  // Work IDs are not necessarily song IDs. Never silently look up a different
  // song by treating the evaluation ID as a track ID.
  const song: Song = work.song || work.songInfo || work.music || {}
  const id = song.id || work.resourceId || work.songId || work.musicId
  let detail = song
  const warnings: string[] = []
  let lyrics = text(work.lyricContent, 12000)
  if (id && /^\d+$/.test(String(id))) {
    const responses = await Promise.allSettled([
      api("/api/v3/song/detail", { c: JSON.stringify([{ id: String(id) }]) }),
      api("/api/song/lyric", { id: String(id), lv: -1, tv: -1, kv: -1 }),
    ])
    if (responses[0].status === "fulfilled") detail = responses[0].value?.songs?.find(row => String(row.id) === String(id)) || song
    else warnings.push($t("services.music.partner-review.text_ed833d8c26"))
    if (responses[1].status === "fulfilled") lyrics = text(responses[1].value?.lrc?.lyric || lyrics, 12000).replace(/\[\d{1,3}:\d{2}(?:\.\d+)?\]/g, "")
    else warnings.push($t("services.music.partner-review.text_0827fd9e2b"))
  }
  const artists = detail.ar || detail.artists || work.artists || work.artistList || []
  const artist = artists[0]
  let biography = ""
  if (artist?.id && /^\d+$/.test(String(artist.id))) {
    try { biography = text((await api("/api/artist/introduction", { id: String(artist.id) }))?.briefDesc, 3000) }
    catch { warnings.push($t("services.music.partner-review.text_a8244d97b2")) }
  }
  return {
    work_id: String(work.id || ""), song_id: id ? String(id) : "",
    title: text(detail.name || work.name, 300), artists: names(artists).length ? names(artists) : [text(work.authorName, 300)].filter(Boolean),
    album: text(detail.al?.name || detail.album?.name, 300),
    introduction: text(work.description || work.desc || detail.description),
    style: text(work.style, 300), tags: names(work.tags || detail.tags), biography, lyrics, warnings,
    url: id ? `https://music.163.com/song?id=${encodeURIComponent(String(id))}` : "",
  }
}

export function reviewPrompt(context: ReviewContext, maxChars: number) {
  const targetMax = Math.min(80, maxChars)
  const targetMin = Math.min(40, targetMax)
  return $t("services.music.partner-review.text_0b132116de")
    + $t("services.music.partner-review.text_16b7a5064f")
    + $t("services.music.partner-review.text_7189e430d0")
    + $t("services.music.partner-review.text_3757168e9f", { "targetMin": targetMin, "targetMax": targetMax, "maxChars": maxChars })
    + $t("services.music.partner-review.text_0dcfbf68d6", { "value1": JSON.stringify(context) })
}

export function validateReview(value: ReviewOutput | null | undefined, maxChars: number) {
  const comment = typeof value?.comment === "string" ? value.comment.trim() : ""
  const sources = Array.isArray(value?.sources) ? [...new Set(value.sources)].filter((url): url is string => {
    try { const parsed = new URL(url); return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password } catch { return false }
  }).slice(0, 10) : []
  if (!comment) throw new Error($t("services.music.partner-review.text_5ca12c110d"))
  if (comment.length < 20 || comment.length > maxChars || /https?:\/\/|【\d+】||```/.test(comment) || !sources.length) {
    throw new Error($t("services.music.partner-review.text_4f6012273d"))
  }
  return { comment, sources }
}

export class PartnerReviewService {
  private readonly fetch: NonNullable<ReviewServiceOptions["fetch"]>
  private readonly spawn: NonNullable<ReviewServiceOptions["spawnProcess"]>

  constructor({ fetch = globalThis.fetch, spawnProcess = spawn }: ReviewServiceOptions = {}) {
    this.fetch = fetch
    this.spawn = spawnProcess
  }

  async generate(context: ReviewContext, config: ReviewConfig = {}, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const maxChars = config.max_chars ?? 140
    const prompt = reviewPrompt(context, maxChars)
    const result = config.mode === "codex" ? await this.codex(prompt, config, signal) : config.mode === "responses" ? await this.responses(prompt, config, signal) : null
    if (!result) throw new Error($t("services.music.partner-review.text_f2c923ae80"))
    return validateReview(result, maxChars)
  }

  async responses(prompt: string, config: ReviewConfig, signal?: AbortSignal): Promise<ReviewOutput> {
    if (!config.api_key || !config.model) throw new Error($t("services.music.partner-review.text_a80f5c7206"))
    const url = new URL(config.api_url || "https://api.openai.com/v1/responses")
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password) throw new Error($t("services.music.partner-review.text_5357bfaa0a"))
    const timeout = AbortSignal.timeout(config.timeout_ms || 180000)
    let response
    try {
      response = await this.fetch(url, {
        method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.api_key}` },
        body: JSON.stringify({ model: config.model, store: false, input: prompt,
          tools: [{ type: "web_search" }], tool_choice: "required",
          include: ["web_search_call.action.sources"],
          text: { format: { type: "json_schema", name: "music_review", strict: true, schema } } }),
      })
    } catch { signal?.throwIfAborted(); throw new Error($t("services.music.partner-review.text_8e2cfa4bb4")) }
    if (!response.ok) throw new Error($t("services.music.partner-review.text_ae5df5d861", { "status": response.status }))
    let data: { status?: string; output?: ResponseOutput[] }
    try { data = await response.json() } catch { throw new Error($t("services.music.partner-review.text_3c3a61cf6f")) }
    if (data.status !== "completed" || !data.output?.some(item => item.type === "web_search_call" && item.status === "completed")) throw new Error($t("services.music.partner-review.text_d7028aeb86"))
    const output = data.output.filter(item => item.type === "message").flatMap(item => item.content || []).filter(item => item.type === "output_text").map(item => item.text).join("")
    let parsed: ReviewOutput
    try { parsed = JSON.parse(output) } catch { throw new Error($t("services.music.partner-review.text_4804b7d307")) }
    const searchedUrls = new Set()
    for (const item of data.output) {
      if (item.type === "web_search_call" && item.status === "completed") {
        for (const source of item.action?.sources || []) if (typeof source?.url === "string") searchedUrls.add(source.url)
      }
      if (item.type === "message") for (const content of item.content || []) {
        for (const annotation of content.annotations || []) {
          if (annotation.type === "url_citation" && typeof annotation.url === "string") searchedUrls.add(annotation.url)
        }
      }
    }
    if (!Array.isArray(parsed?.sources) || !parsed.sources.length || parsed.sources.some(url => typeof url !== "string" || !searchedUrls.has(url))) {
      throw new Error($t("services.music.partner-review.text_a88a08170a"))
    }
    return parsed
  }

  async codex(prompt: string, config: ReviewConfig, signal?: AbortSignal): Promise<ReviewOutput> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-review-"))
    try {
      const output = path.join(dir, "review.json"), schemaFile = path.join(dir, "schema.json")
      await fs.writeFile(schemaFile, JSON.stringify(schema), { mode: 0o600 })
      const args = ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--json", "--color", "never",
        "-c", 'web_search="live"', "-c", 'approval_policy="never"', "-c", "features.shell_tool=false",
        "--output-schema", schemaFile, "--output-last-message", output]
      if (config.model) args.push("--model", config.model)
      args.push("-")
      const searched = await new Promise<boolean>((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams
        let timer: ReturnType<typeof setTimeout>, killTimer: ReturnType<typeof setTimeout> | undefined
        let buffer = "", didSearch = false, settled = false, bytes = 0
        const kill = (signal: NodeJS.Signals) => {
          try {
            if (child.pid === undefined) throw new Error($t("services.music.partner-review.text_d2d2681df7"))
            process.kill(-child.pid, signal)
          } catch { child?.kill(signal) }
        }
        const abort = () => fail($t("services.music.partner-review.text_4119586a62"))
        const fail = (message: string) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener("abort", abort)
          kill("SIGTERM")
          killTimer = setTimeout(() => kill("SIGKILL"), 1000)
          killTimer.unref()
          reject(new Error(message))
        }
        signal?.throwIfAborted()
        try { child = this.spawn(config.codex_command || "codex", args, { cwd: dir, detached: true, stdio: ["pipe", "pipe", "pipe"], shell: false }) }
        catch { reject(new Error($t("services.music.partner-review.text_8ef22fc5e2"))); return }
        timer = setTimeout(() => fail($t("services.music.partner-review.text_d1ff005610")), config.timeout_ms || 180000)
        signal?.addEventListener("abort", abort, { once:true })
        child.on("error", () => fail($t("services.music.partner-review.text_8ef22fc5e2")))
        child.stdin.on("error", () => {})
        child.stdout.on("data", chunk => {
          bytes += chunk.length
          if (bytes > 4 * 1024 * 1024) { fail($t("services.music.partner-review.text_3969a0997d")); return }
          buffer += chunk.toString()
          const lines = buffer.split("\n"); buffer = lines.pop() ?? ""
          for (const line of lines) { try { const event = JSON.parse(line); if (event.type === "item.completed" && event.item?.type === "web_search") didSearch = true } catch {} }
        })
        // Drain diagnostic output, but never persist credentials or raw errors.
        child.stderr.resume()
        child.on("close", code => {
          clearTimeout(timer)
          clearTimeout(killTimer)
          signal?.removeEventListener("abort", abort)
          if (settled) return
          settled = true
          if (code === 0) resolve(didSearch)
          else reject(new Error($t("services.music.partner-review.text_8c294c9601")))
        })
        child.stdin.end(prompt)
      })
      if (!searched) throw new Error($t("services.music.partner-review.text_2ab2abd0df"))
      try { return JSON.parse(await fs.readFile(output, "utf8")) } catch { throw new Error($t("services.music.partner-review.text_d12a38936c")) }
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  }
}
