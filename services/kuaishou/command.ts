import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { load } from "cheerio"
import { join } from "node:path"
import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { resolveData } from "../../core/path.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderSourceCard } from "../../core/render/source-cards.ts"
import { kuaishouCoverUrl, kuaishouVideoUrl, type MediaFetch } from "../media/cdn.ts"
import { downloadMedia } from "../media/download.ts"
import { mediaDeliveryUnknown, safeMediaName, sendMediaFile } from "../media/files.ts"
import { buildMediaMessageText, isMediaCommandText } from "../media/message.ts"
import { createMediaTask, recoverMediaTasks, releaseMediaTask } from "../media/tasks.ts"
import { readPublicSharePage } from "../public-share/page.ts"
import { createKuaishouSettings } from "./settings.ts"

const origin = "https://v.m.chenzhongtech.com"
const agent = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36"
const feature = "[media] 快手解析"
const link = /(?<=^|[\s"'([{>：，。])https?:\/\/(?:v\.kuaishou\.com\/[a-z\d]{3,40}|www\.kuaishou\.com\/short-video\/[a-z\d]{3,40}|[a-z\d]+\.m\.chenzhongtech\.com\/fw\/photo\/[a-z\d]{3,40})(?=$|[\s"'\])}<>,.?/#&，。！？；：])/iu

function sourceId(url: URL) {
  if (url.protocol !== "https:" || url.port || url.username || url.password) return
  if (url.hostname === "www.kuaishou.com") return /^\/short-video\/([a-z\d]{3,40})\/?$/u.exec(url.pathname)?.[1]
  if (/^[a-z\d]+\.m\.chenzhongtech\.com$/u.test(url.hostname)) return /^\/fw\/photo\/([a-z\d]{3,40})\/?$/u.exec(url.pathname)?.[1]
}

function allowed(url: URL) {
  return Boolean(sourceId(url)) || (url.origin === "https://v.kuaishou.com" && !url.username && !url.password && /^\/[A-Za-z\d]{3,40}\/?$/u.test(url.pathname))
}

function row(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, limit: number) {
  return typeof value === "string" ? Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim()).slice(0, limit).join("") : ""
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function parseKuaishouH5(html: string, id: string) {
  const $ = load(html)
  const json = $("script:not([src])").toArray().map(node => $(node).text())
    .find(value => /^\s*window\.INIT_STATE\s*=/u.test(value))
    ?.replace(/^\s*window\.INIT_STATE\s*=\s*/u, "").replace(/;\s*$/u, "").trim()
  if (!json) return
  const matches = Object.values(row(JSON.parse(json))).map(value => row(row(value).photo)).filter(photo =>
    typeof photo.share_info === "string" && new URLSearchParams(photo.share_info).get("photoId") === id && photo.photoStatus === 0)
  if (matches.length !== 1) return
  const photo = matches[0]!
  const cover = (Array.isArray(photo.coverUrls) ? photo.coverUrls : []).flatMap(item => kuaishouCoverUrl(text(row(item).url, 4096)) ?? [])[0]?.href
  const video = photo.type === 1 && photo.photoType === "VIDEO" && Array.isArray(photo.mainMvUrls)
    ? photo.mainMvUrls.flatMap(item => kuaishouVideoUrl(text(row(item).url, 4096)) ?? [])[0]
    : undefined
  return { title: text(photo.caption, 160) || $t("services.kuaishou.command.text_1322a0ba8a"), owner: text(photo.userName, 80), cover, video,
    type: photo.photoType === "VIDEO" ? "video" : "gallery",
    duration: (count(photo.duration) ?? 0) / 1000, createdAt: (count(photo.timestamp) ?? 0) / 1000,
    stat: { like: count(photo.likeCount), reply: count(photo.commentCount), share: count(photo.shareCount), view: count(photo.viewCount) } }
}

export function createKuaishouCommands({ signal: lifecycle, mediaRuntime, fetch = globalThis.fetch, render = renderSourceCard,
  loadConfig = loadGlobalConfig, settings = createKuaishouSettings(), tasksDir = resolveData("kuaishou", "tasks") }: {
  readonly signal?: AbortSignal
  readonly mediaRuntime?: { whenReady(start: () => void): () => void }
  readonly fetch?: MediaFetch
  readonly render?: typeof renderSourceCard
  readonly loadConfig?: typeof loadGlobalConfig
  readonly settings?: ReturnType<typeof createKuaishouSettings>
  readonly tasksDir?: string
} = {}) {
  const stopped = new AbortController()
  const signal = lifecycle ? AbortSignal.any([lifecycle, stopped.signal]) : stopped.signal
  const running = new Set<Promise<void>>()
  let recovery: Promise<unknown> | undefined
  const cancelRecovery = mediaRuntime?.whenReady(() => {
    if (!signal.aborted) recovery = recoverMediaTasks(tasksDir).catch(() => console.warn($t("services.kuaishou.command.text_41fae3bd27")))
  })

  function identify(message: string, context: MessageFallbackContext) {
    if (signal.aborted || context.isDelegated || context.message_type === "terminal" || isMediaCommandText(message)) return
    const url = URL.parse(link.exec(buildMediaMessageText({ ...context, msg: message }))?.[0] ?? "")
    if (!url) return
    url.protocol = "https:"
    return allowed(url) ? url : undefined
  }

  async function send(video: URL, title: string, context: MessageFallbackContext, active: AbortSignal) {
    let task: Awaited<ReturnType<typeof createMediaTask>> | undefined
    try {
      await recovery
      active.throwIfAborted()
      task = await createMediaTask(tasksDir)
      const { file } = await downloadMedia(video.href, join(task.dir, "video"), {
        fetch, kind: "video", cdn: "kuaishou-video", timeoutMs: 60_000, maxBytes: 100 * 1024 * 1024,
        headers: { Referer: origin + "/" }, signal: active,
      })
      await sendMediaFile(context, file, { file_name: safeMediaName(title) + ".mp4", signal: active })
    } catch (error) {
      if (!active.aborted) {
        const unknown = error instanceof Error && "code" in error && error.code === mediaDeliveryUnknown
        if (!unknown) await context.reply($t("services.kuaishou.command.text_ed74eb8a23"))
      }
    } finally {
      if (task) await releaseMediaTask(tasksDir, task.dir).catch(() => console.warn($t("services.kuaishou.command.text_80d115ce60")))
    }
  }

  const fallback: MessageFallback = async (message, context) => {
    const source = identify(message, context)
    if (!source) return
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
    const active = connection ? AbortSignal.any([signal, connection]) : signal
    try {
      const cfg = await loadConfig()
      const options = await settings.settings(cfg.tools)
      if (!options.enable || (context.message_type === "private" && !options.private)) return
      const id = sourceId(source)
      const start = source.hostname === "www.kuaishou.com" && id ? new URL(`/fw/photo/${id}`, origin) : source
      const page = await readPublicSharePage(start, allowed, fetch, AbortSignal.any([active, AbortSignal.timeout(12_000)]), { "User-Agent": agent })
      const resolved = page && sourceId(page.url)
      const post = page && resolved && (!id || resolved === id) ? parseKuaishouH5(page.html, resolved) : undefined
      if (!post) return $t("services.kuaishou.command.text_5c1e5784fa")
      const canonical = new URL(`/fw/photo/${resolved}`, origin).href
      const card = await render("kuaishou-info", { ...post, id: `快手 · ${resolved}` }).catch(() => undefined)
      active.throwIfAborted()
      const head = card && card.byteLength <= (context.inlineImageByteLimit ?? 16 * 1024 * 1024)
        ? [{ type: "image" as const, file: card }, canonical]
        : [$t("services.kuaishou.command.text_3c4aa1e0e2", { "title": post.title }), post.owner && $t("services.kuaishou.command.text_4c59ffb174", { "owner": post.owner }), canonical].filter(Boolean).join("\n")
      const video = post.video
      if (!video || !new PermissionService({ permissions: cfg.permissions }).can(context, "kuaishou.download")) return head
      let started = false
      return { type: "delivery", message: head, onDelivered: async () => {
        if (started || active.aborted) return
        started = true
        const pending = send(video, post.title, context, active)
        running.add(pending)
        try { await pending } finally { running.delete(pending) }
      } }
    } catch { if (!active.aborted) return $t("services.kuaishou.command.text_74d0257cf1") }
  }

  return {
    fallback,
    features: (context: MessageFallbackContext) => identify(context.normalizedMessage, context) ? [feature] : [],
    async dispose() {
      stopped.abort()
      cancelRecovery?.()
      await Promise.allSettled([recovery, ...running])
    },
  }
}
