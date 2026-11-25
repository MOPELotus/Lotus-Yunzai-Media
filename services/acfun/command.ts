import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import { loadAcfunConfig } from "../../core/config/global.ts"
import { resolveData } from "../../core/path.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderTemplate } from "../../core/render/service.ts"
import type { MediaFetch } from "../media/cdn.ts"
import { downloadMedia } from "../media/download.ts"
import { mediaDeliveryUnknown, runMediaProcess, safeMediaName, sendMediaFile } from "../media/files.ts"
import { buildMediaMessageText, isMediaCommandText } from "../media/message.ts"
import { createMediaTask, recoverMediaTasks, releaseMediaTask } from "../media/tasks.ts"
import { findMediaTool } from "../media/video.ts"
import { acfunInfo, acfunPage, acfunPlaylist, exactAcfunTarget, sharedAcfunTarget, type AcfunTarget } from "./source.ts"

const feature = "[media] AcFun 解析"
const playCommand = /^#播放\s*(\S+)$/u
const defaultByteLimit = 100 * 1024 ** 2
const inlineLimit = 16 * 1024 ** 2
const messageWindowMs = 10 * 60_000

type Services = {
  readonly signal?: AbortSignal
  readonly mediaRuntime?: { whenReady(start: () => void): () => void }
}

type Options = {
  readonly fetch?: MediaFetch
  readonly loadConfig?: typeof loadAcfunConfig
  readonly render?: typeof renderTemplate
  readonly tasksDir?: string
}

type AcfunVideo = Awaited<ReturnType<typeof acfunInfo>>

function action(message: string, context: MessageFallbackContext) {
  if (context.isDelegated || (context.message_type !== "group" && context.message_type !== "private")) return
  const request = playCommand.exec(message)?.[1]
  if (request) {
    const target = exactAcfunTarget(request)
    if (target) return { target, play: true }
  }
  if (message.startsWith("#") || isMediaCommandText(message)) return
  const target = exactAcfunTarget(message.trim()) ?? sharedAcfunTarget(buildMediaMessageText({ ...context, msg: message }))
  if (target) return { target, play: false }
}

async function playableSegments(video: AcfunVideo, fetch: MediaFetch, signal: AbortSignal) {
  for (const source of video.sources.at(-1)?.files ?? []) {
    try { return await acfunPlaylist(source, fetch, signal) }
    catch { signal.throwIfAborted() }
  }
  throw new Error($t("services.acfun.command.text_c885c5f9d8"))
}

async function muxVideo(video: AcfunVideo, paths: readonly string[], dir: string, ffmpeg: string, signal: AbortSignal, limit: number) {
  const list = join(dir, "segments.txt")
  const output = join(dir, "video.mp4")
  await writeFile(list, paths.map(file => `file '${file}'`).join("\n") + "\n", { flag: "wx" })
  await runMediaProcess(ffmpeg, [
    "-nostdin", "-v", "error", "-f", "concat", "-safe", "1", "-protocol_whitelist", "file",
    "-i", list, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", output,
  ], { cwd: dir, timeoutMs: 45_000, signal })
  const result = await stat(output)
  if (!result.size || result.size > limit) throw new Error($t("services.acfun.command.text_c71e378567"))
  return { file: output, name: safeMediaName(video.title) + ".mp4" }
}

export function createAcfunCommands({ signal: lifecycle, mediaRuntime }: Services = {}, {
  fetch = globalThis.fetch, loadConfig = loadAcfunConfig, render = renderTemplate, tasksDir = resolveData("acfun", "tasks"),
}: Options = {}) {
  const stopped = new AbortController()
  const signal = lifecycle ? AbortSignal.any([lifecycle, stopped.signal]) : stopped.signal
  const work = new Set<Promise<unknown>>()
  const deliveries = new Map<string, number>()
  let recovery: Promise<unknown> | undefined
  const cancelRecovery = mediaRuntime?.whenReady(() => {
    if (!signal.aborted) recovery = recoverMediaTasks(tasksDir).catch(() => console.warn($t("services.acfun.command.text_8d461d00da")))
  })

  function reserve(context: MessageFallbackContext) {
    if (context.message_id === undefined) return true
    const peer = context.message_type === "group" ? context.group_id : context.user_id
    const key = [context.adapter ?? "onebot", context.self_id, context.message_type, peer, context.message_id].join(":")
    const now = Date.now()
    for (const [id, expires] of deliveries) {
      if (expires > now) break
      deliveries.delete(id)
    }
    if (deliveries.has(key)) return false
    if (deliveries.size >= 2048) deliveries.delete(deliveries.keys().next().value!)
    deliveries.set(key, now + messageWindowMs)
    return true
  }

  async function play(target: AcfunTarget, context: MessageFallbackContext, connection: AbortSignal) {
    let task: Awaited<ReturnType<typeof createMediaTask>> | undefined
    const active = AbortSignal.any([connection, AbortSignal.timeout(180_000)])
    try {
      await recovery
      active.throwIfAborted()
      const ffmpeg = await findMediaTool("ffmpeg")
      if (!ffmpeg) return $t("services.acfun.command.text_5956373d13")
      const video = await acfunInfo(target, fetch, active)
      const segments = await playableSegments(video, fetch, active)
      task = await createMediaTask(tasksDir)
      const limit = context.deliverMedia ? defaultByteLimit : inlineLimit
      let remaining = limit
      const files: string[] = []
      for (const [index, url] of segments.entries()) {
        active.throwIfAborted()
        if (remaining <= 0) throw new Error($t("services.acfun.command.text_c71e378567"))
        const basename = `segment-${index}`
        const result = await downloadMedia(url, join(task.dir, basename), {
          fetch, signal: active, kind: "video", cdn: "acfun-video", timeoutMs: 25_000, maxBytes: remaining,
        })
        if (result.file !== join(task.dir, basename + ".ts")) throw new Error($t("services.acfun.command.text_d440da26f7"))
        remaining -= result.sizeBytes
        files.push(basename + ".ts")
      }
      const media = await muxVideo(video, files, task.dir, ffmpeg, active, limit)
      await sendMediaFile(context, media.file, { file_name: media.name, signal: active, video_size_limit_mb: limit / 1024 ** 2 })
      return []
    } catch (error) {
      if (connection.aborted) return []
      if (error instanceof Error && "code" in error && error.code === mediaDeliveryUnknown) {
        return $t("services.acfun.command.text_d067c369b9")
      }
      return $t("services.acfun.command.text_e0c288703a") + acfunPage(target)
    } finally {
      if (task) await releaseMediaTask(tasksDir, task.dir).catch(() => console.warn($t("services.acfun.command.text_588e89b2a3")))
    }
  }

  async function preview(target: AcfunTarget, context: MessageFallbackContext, active: AbortSignal) {
    try {
      const video = await acfunInfo(target, fetch, active)
      const { id, part, title, owner, duration, createdAt, desc, cover, stat, url, sources } = video
      const source = sources.at(-1)
      const hint = source ? $t("services.acfun.command.text_33a4b034bb") + url : url
      const model = { title, owner, duration, createdAt, desc, cover, stat, type: "video", id: `AcFun · ac${id}${part === undefined ? "" : " · P" + part}`,
        sources: source ? [{ quality: source.quality, width: source.width, height: source.height }] : [] }
      const maxBytes = context.inlineImageByteLimit ?? inlineLimit
      let image = await render("acfun-info", model).catch(() => undefined)
      if (image && image.byteLength > maxBytes && Number(Bun.env.LOTUS_RENDER_SCALE ?? 4) > 2 && !active.aborted) {
        image = await render("acfun-info", model, { renderScale: 2 }).catch(() => undefined)
      }
      if (active.aborted) return []
      if (image && image.byteLength <= maxBytes) return [{ type: "image" as const, file: image }, hint]
      return [`AcFun · ${title}`, owner, desc, hint].filter(Boolean).join("\n")
    } catch {
      if (active.aborted) return []
      return $t("services.acfun.command.text_5a090eb5f6") + acfunPage(target)
    }
  }

  const fallback: MessageFallback = async (message, context) => {
    const request = action(message, context)
    if (!request) return
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
    const active = connection ? AbortSignal.any([signal, connection]) : signal
    if (active.aborted) return []
    const cfg = await loadConfig()
    if (active.aborted) return []
    const scope = request.play ? "acfun.play" : "acfun.preview"
    const allowed = cfg.enable && new PermissionService({ permissions: cfg.permissions }).can(context, scope)
    if (!allowed) return request.play ? $t("services.acfun.command.text_b251651dfe") : undefined
    if (!request.play) {
      if (context.message_type === "private" && !cfg.privatePreview) return
      return preview(request.target, context, active)
    }
    if (!reserve(context)) return []
    const pending = play(request.target, context, active)
    work.add(pending)
    try { return await pending } finally { work.delete(pending) }
  }

  return {
    fallback,
    features(context: MessageFallbackContext) { return action(context.normalizedMessage, context) ? [feature] : [] },
    async dispose() {
      stopped.abort()
      cancelRecovery?.()
      await Promise.allSettled([...work, recovery])
      deliveries.clear()
    },
  }
}
