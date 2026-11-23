import { load } from "cheerio"
import { join } from "node:path"
import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { resolveData } from "../../core/path.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderSourceCard } from "../../core/render/source-cards.ts"
import { isPipixiaVideoUrl, type MediaFetch } from "../media/cdn.ts"
import { downloadMedia } from "../media/download.ts"
import { mediaDeliveryUnknown, safeMediaName, sendMediaFile } from "../media/files.ts"
import { buildMediaMessageText, isMediaCommandText } from "../media/message.ts"
import { createMediaTask, recoverMediaTasks, releaseMediaTask } from "../media/tasks.ts"
import { createPipixiaSettings } from "./settings.ts"

const origin = "https://h5.pipix.com"
const feature = "[media] 皮皮虾解析"
const link = /(?<=^|[\s"'([{>：，。])https?:\/\/h5\.pipix\.com\/(?:(?:ppx\/)?item\/[1-9]\d{0,19}|s\/[A-Za-z\d_-]{1,48})(?=$|[\s"'\])}<>,.?/#&，。！？；：])/iu
const itemPath = /^\/(?:ppx\/)?item\/([1-9]\d{0,19})\/?$/u
const shortPath = /^\/s\/[A-Za-z\d_-]{1,48}\/?$/u
const agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
const maxHtml = 2_000_000

function row(input: unknown) {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function clean(input: unknown, limit: number) {
  if (typeof input !== "string") return ""
  return Array.from(input.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim()).slice(0, limit).join("")
}

function httpNumber(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : undefined
}

function sources(input: unknown, allow: (url: URL) => boolean): URL[] {
  const values = row(input).url_list
  if (!Array.isArray(values)) return []
  return values.slice(0, 10).flatMap(value => {
    const href = row(value).url
    if (typeof href !== "string" || href.length > 4096) return []
    const url = URL.parse(href)
    if (url?.protocol === "http:") url.protocol = "https:"
    return url && allow(url) ? [url] : []
  })
}

function coverUrl(url: URL) {
  return url.protocol === "https:" && !url.port && !url.username && !url.password && !url.hash &&
    /^p\d+-ppx(?:-sign)?\.byteimg\.com$/u.test(url.hostname)
}

function shareTarget(url: URL) {
  if (url.origin === origin && !url.username && !url.password &&
      (itemPath.test(url.pathname) || shortPath.test(url.pathname))) return url
}

async function fetchPost(start: URL, fetch: MediaFetch, signal: AbortSignal) {
  const expectedId = itemPath.exec(start.pathname)?.[1]
  let url = shareTarget(start)
  for (let hop = 0; url && hop <= 5; hop++) {
    const response = await fetch(url.href, { credentials: "omit", redirect: "manual", signal,
      headers: { "User-Agent": agent, Accept: "text/html,application/xhtml+xml" } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const target = response.headers.get("location")
      const next = target && URL.parse(target, url)
      url = next ? shareTarget(next) : undefined
      continue
    }
    const id = itemPath.exec(url.pathname)?.[1]
    if (!id || (expectedId && id !== expectedId) || !response.ok || !response.body || Number(response.headers.get("content-length")) > maxHtml) {
      await response.body?.cancel()
      break
    }
    const chunks = []
    let length = 0
    for await (const part of response.body) {
      length += part.byteLength
      if (length > maxHtml) throw new Error("皮皮虾页面过大。")
      chunks.push(part)
    }
    const document = load(Buffer.concat(chunks, length).toString("utf8"))
    const encoded = document('script#RENDER_DATA[type="application/json"]').first().text()
    const data = row(JSON.parse(decodeURIComponent(encoded)))
    const item = row(row(data.ppxItemDetail).item)
    if (item.item_id_str !== id || item.status !== 0) break
    const source = new URL(url.pathname, origin).href
    const title = clean(item.content, 160) || clean(row(item.share).title, 160) || "皮皮虾作品"
    const owner = clean(row(item.author).name, 80)
    const cover = sources(item.cover, coverUrl)[0]?.href
    const video = row(item.video)
    const downloadable = item.can_download === true
      ? [video.origin_video_download, item.origin_video_download, video.video_download].flatMap(format => sources(format, isPipixiaVideoUrl))[0]
      : undefined
    const raw = row(item.stats)
    const stat = { like: httpNumber(raw.like_count), reply: httpNumber(raw.comment_count),
      share: httpNumber(raw.share_count), view: httpNumber(raw.play_count) }
    const cells = row(data.ppxCellComment).cell_comments
    const comments = Array.isArray(cells) ? cells.slice(0, 50).flatMap(cell => {
      const comment = row(row(cell).comment_info)
      const text = clean(comment.text, 500)
      if (!text) return []
      const author = clean(row(comment.user).name, 80) || clean(row(comment.user).nickname, 80) || "匿名用户"
      const created = httpNumber(comment.create_time)
      const time = created && created < 4_102_444_800
        ? new Date(created * 1_000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : ""
      return [`${author}\n${text}\n${time ? time + " · " : ""}点赞 ${httpNumber(comment.like_count) ?? 0} · 回复 ${httpNumber(comment.reply_count) ?? 0}`]
    }) : []
    return { id, source, title, owner, cover, downloadable, stat, comments, duration: httpNumber(item.duration), createdAt: httpNumber(item.create_time) }
  }
}

export function createPipixiaCommands({ signal: lifecycle, mediaRuntime, fetch = globalThis.fetch, render = renderSourceCard,
  loadConfig = loadGlobalConfig, settings = createPipixiaSettings(), tasksDir = resolveData("pipixia", "tasks") }: {
  readonly signal?: AbortSignal
  readonly mediaRuntime?: { whenReady(start: () => void): () => void }
  readonly fetch?: MediaFetch
  readonly render?: typeof renderSourceCard
  readonly loadConfig?: typeof loadGlobalConfig
  readonly settings?: ReturnType<typeof createPipixiaSettings>
  readonly tasksDir?: string
} = {}) {
  const stopped = new AbortController()
  const signal = lifecycle ? AbortSignal.any([lifecycle, stopped.signal]) : stopped.signal
  const deliveries = new Set<Promise<void>>()
  let recovery: Promise<unknown> | undefined
  const cancelRecovery = mediaRuntime?.whenReady(() => {
    if (!signal.aborted) recovery = recoverMediaTasks(tasksDir).catch(() => console.warn("[media] 皮皮虾任务恢复失败。"))
  })

  function identify(message: string, context: MessageFallbackContext) {
    if (signal.aborted || context.isDelegated || context.message_type === "terminal" || isMediaCommandText(message)) return
    const matched = link.exec(buildMediaMessageText({ ...context, msg: message }))?.[0]
    if (!matched) return
    const url = new URL(matched)
    url.protocol = "https:"
    if (shortPath.test(url.pathname)) url.pathname = url.pathname.replace(/\/?$/u, "/")
    return shareTarget(url)
  }

  const fallback: MessageFallback = async (message, context) => {
    const target = identify(message, context)
    if (!target) return
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
    const active = connection ? AbortSignal.any([signal, connection]) : signal
    try {
      const cfg = await loadConfig()
      const options = await settings.settings(cfg.tools)
      if (!options.enable || (context.message_type === "private" && !options.private)) return
      const post = await fetchPost(target, fetch, AbortSignal.any([active, AbortSignal.timeout(12_000)]))
      if (!post) return "皮皮虾未返回该公开作品。"
      const { like, reply, share, view } = post.stat
      const counts = [`点赞 ${like ?? "未记录"}`, `评论 ${reply ?? "未记录"}`, `分享 ${share ?? "未记录"}`, `播放 ${view ?? "未记录"}`].join(" · ")
      const witness = [`皮皮虾 · ${post.title}`, post.owner ? `作者：${post.owner}` : undefined, counts, post.source].filter(Boolean)
      const card = await render("pipixia-info", { ...post, id: `皮皮虾 · ${post.id}` }).catch(() => undefined)
      active.throwIfAborted()
      const head = card && card.byteLength <= (context.inlineImageByteLimit ?? 16 * 1024 * 1024)
        ? [{ type: "image" as const, file: card }, post.source] : witness.join("\n")
      const canDownload = post.downloadable && new PermissionService({ permissions: cfg.permissions }).can(context, "pipixia.download")
      if (!canDownload && !post.comments.length) return head
      let started = false
      return {
        type: "delivery",
        message: head,
        onDelivered: async () => {
          if (started || active.aborted) return
          started = true
          const pending = (async () => {
            if (post.downloadable && canDownload) {
              let task: Awaited<ReturnType<typeof createMediaTask>> | undefined
              try {
                await recovery
                active.throwIfAborted()
                task = await createMediaTask(tasksDir)
                const { file } = await downloadMedia(post.downloadable.href, join(task.dir, "video"), {
                  fetch, kind: "video", cdn: "pipixia-video", timeoutMs: 60_000, maxBytes: 100 * 1024 * 1024,
                  headers: { Referer: origin + "/" }, signal: active,
                })
                await sendMediaFile(context, file, { file_name: safeMediaName(post.title) + ".mp4", signal: active })
              } catch (error) {
                if (!active.aborted) {
                  const unknown = error instanceof Error && "code" in error && error.code === mediaDeliveryUnknown
                  await context.reply(unknown ? "视频送达未确认，请核对当前会话。" : "皮皮虾视频暂未送达，可打开上面的原帖。")
                }
              } finally {
                if (task) await releaseMediaTask(tasksDir, task.dir).catch(() => console.warn("[media] 皮皮虾任务清理失败。"))
              }
            }
            if (!active.aborted && context.forward && post.comments.length) await context.forward(post.comments, "皮皮虾评论")
          })()
          deliveries.add(pending)
          try { await pending } finally { deliveries.delete(pending) }
        },
      }
    } catch { if (!active.aborted) return "暂时无法读取皮皮虾公开作品。" }
  }

  return {
    fallback,
    features: (context: MessageFallbackContext) => identify(context.normalizedMessage, context) ? [feature] : [],
    async dispose() {
      stopped.abort()
      cancelRecovery?.()
      await Promise.allSettled([recovery, ...deliveries])
    },
  }
}
