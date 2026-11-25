import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { join } from "node:path"
import type { CommandReply, MessageFallbackContext } from "../../../../lib/commands.ts"
import type { MessageReply } from "../../../../lib/messages.ts"
import { loadPublicShareConfig } from "../../core/config/global.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { resolveData } from "../../core/path.ts"
import { fetchImageBytes } from "../../core/render/image.ts"
import { renderSourceCard } from "../../core/render/source-cards.ts"
import { type MediaFetch } from "../media/cdn.ts"
import { downloadMedia, sniffMedia } from "../media/download.ts"
import { mediaDeliveryUnknown, safeMediaName, sendMediaFile } from "../media/files.ts"
import { buildMediaMessageText, isMediaCommandText } from "../media/message.ts"
import { createMediaTask, recoverMediaTasks, releaseMediaTask } from "../media/tasks.ts"
import { parsePublicShare, readPublicShare, type PublicShare } from "./source.ts"

const names = { weishi: $t("services.public-share.command.text_e7b7b38f38"), zuiyou: $t("services.public-share.command.text_ff74373e3f") }
const links = /https?:\/\/[^\s<>"'，。！？；）】]+/giu
const maxVideo = 100 * 1024 * 1024
const maxInline = 16 * 1024 * 1024
const maxGallery = 20
const maxGalleryBytes = 16 * 1024 * 1024

function identify(message: string, context: MessageFallbackContext) {
  if (context.isDelegated || (context.message_type !== "group" && context.message_type !== "private")) return
  const play = /^#播放\s+(\S+)\s*$/u.exec(message)
  const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
  if (play?.[1]) {
    const target = parsePublicShare(play[1])
    if (target) return { target, play: true, connection }
    return
  }
  if (isMediaCommandText(message) || connection?.aborted ||
      (context.message_type === "private" && !connection)) return
  const text = buildMediaMessageText({ ...context, msg: message }).replaceAll("\\/", "/")
  for (const [value] of text.matchAll(links)) {
    const target = parsePublicShare(value.replace(/[),.]+$/u, ""))
    if (target) return { target, play: false, connection }
  }
}

export function createPublicShareCommands({ signal: lifecycle, mediaRuntime, fetchPage, fetchMedia, loadConfig = loadPublicShareConfig, render = renderSourceCard,
  tasksDir = resolveData("public-share", "tasks") }: {
  readonly signal?: AbortSignal
  readonly mediaRuntime?: { whenReady(start: () => void): () => void }
  readonly fetchPage?: MediaFetch
  readonly fetchMedia?: MediaFetch
  readonly loadConfig?: typeof loadPublicShareConfig
  readonly render?: typeof renderSourceCard
  readonly tasksDir?: string
} = {}) {
  const stopped = new AbortController()
  const signal = lifecycle ? AbortSignal.any([lifecycle, stopped.signal]) : stopped.signal
  const played = new Map<string, number>()
  const downloads = new Set<Promise<CommandReply>>()
  let recovery: Promise<unknown> | undefined
  const cancelRecovery = mediaRuntime?.whenReady(() => {
    if (!signal.aborted) recovery = recoverMediaTasks(tasksDir).catch(() => {})
  })

  function playbackClaim(context: MessageFallbackContext, source: PublicShare) {
    if (context.message_id === undefined) return false
    const key = JSON.stringify([context.adapter, context.self_id, context.message_type, context.group_id ?? context.user_id,
      context.message_id, source.site, source.id])
    const now = Date.now()
    for (const [old, expires] of played) {
      if (expires > now) break
      played.delete(old)
    }
    if (played.has(key)) return false
    if (played.size >= 4096) played.delete(played.keys().next().value!)
    played.set(key, now + 600_000)
    return true
  }

  async function sendVideo(source: PublicShare, context: MessageFallbackContext, active: AbortSignal): Promise<CommandReply> {
    if (!source.video) return $t("services.public-share.command.text_1191a17492", { "value1": names[source.site], "url": source.url })
    if (!playbackClaim(context, source)) return []
    let task: Awaited<ReturnType<typeof createMediaTask>> | undefined
    try {
      await recovery
      active.throwIfAborted()
      task = await createMediaTask(tasksDir)
      const limit = context.deliverMedia ? maxVideo : maxInline
      const { file } = await downloadMedia(source.video.href, join(task.dir, "video"), {
        signal: active, kind: "video", cdn: `${source.site}-video`, maxBytes: limit, timeoutMs: 120_000, fetch: fetchMedia,
      })
      await sendMediaFile(context, file, { signal: active, file_name: safeMediaName(source.title) + file.slice(file.lastIndexOf(".")) })
      return []
    } catch (error) {
      if (active.aborted) return []
      if (error instanceof Error && "code" in error && error.code === mediaDeliveryUnknown) {
        return $t("services.public-share.command.text_63b89edd23")
      }
      return $t("services.public-share.command.text_de901b018d", { "value1": names[source.site], "url": source.url })
    } finally {
      if (task) await releaseMediaTask(tasksDir, task.dir).catch(() => {})
    }
  }

  async function preview(source: PublicShare, context: MessageFallbackContext, active: AbortSignal): Promise<CommandReply> {
    const inlineLimit = context.inlineImageByteLimit ?? maxInline
    const title = source.title
    const site = names[source.site]
    const text = [`${site} · ${title}`, source.owner, source.url,
      source.video && $t("services.public-share.command.text_9edb8af60f")].filter(Boolean).join("\n")
    const card = { title, owner: source.owner, id: site, cover: source.cover, createdAt: source.createdAt,
      type: source.video ? "video" : source.images.length ? "gallery" : "article", duration: source.duration, media: source.images, showStats: false }
    let image = await render("bilibili-info", card).catch(() => undefined)
    if (image && image.byteLength > inlineLimit && Number(Bun.env.LOTUS_RENDER_SCALE ?? 4) > 2 && !active.aborted) {
      image = await render("bilibili-info", card, { renderScale: 2 }).catch(() => undefined)
    }
    if (active.aborted) return []
    const nodes: MessageReply[] = [image && image.byteLength <= inlineLimit ? [{ type: "image", file: image }, text] : text]
    // The post's own image order is independent of recommendations or comment pictures on the page.
    let remaining = maxGalleryBytes
    const gallerySignal = AbortSignal.any([active, AbortSignal.timeout(8_000)])
    for (const url of source.images.slice(0, maxGallery)) {
      if (gallerySignal.aborted || remaining <= 0) break
      try {
        const bytes = await fetchImageBytes(url, { signal: gallerySignal, fetch: fetchMedia, timeoutMs: 3_000,
          maxBytes: Math.min(inlineLimit, remaining, 2 * 1024 * 1024) })
        if (sniffMedia(bytes)?.kind === "image") {
          remaining -= bytes.length
          nodes.push({ type: "image", file: bytes })
        }
      } catch { /* An unavailable image does not hide the source post. */ }
    }
    if (active.aborted) return []
    return nodes.length > 1 ? { type: "forward", nodes } : nodes[0]!
  }

  async function fallback(message: string, context: MessageFallbackContext) {
    const match = identify(message, context)
    if (!match) return
    if (signal.aborted) return []
    if (match.play && match.connection?.aborted !== false) return $t("services.public-share.command.text_7f47165612")
    const active = match.connection ? AbortSignal.any([signal, match.connection]) : signal
    try {
      const config = await loadConfig(match.target.site)
      if (active.aborted) return []
      const scope = `${match.target.site}.${match.play ? "play" : "preview"}`
      if (!config.enable || !new PermissionService({ permissions: config.permissions }).can(context, scope)) {
        return match.play ? $t("services.public-share.command.text_f74cfbf7d9", { "value1": names[match.target.site] }) : undefined
      }
      if (!match.play && context.message_type === "private" && !config.privatePreview) return
      const source = await readPublicShare(match.target, active, fetchPage)
      if (active.aborted) return []
      if (!source) return $t("services.public-share.command.text_21774bab6d", { "value1": names[match.target.site], "href": match.target.url.href })
      if (!match.play) return await preview(source, context, active)
      const pending = sendVideo(source, context, active)
      downloads.add(pending)
      try { return await pending } finally { downloads.delete(pending) }
    } catch {
      return active.aborted ? [] : $t("services.public-share.command.text_ba8fcbeefe", { "value1": names[match.target.site], "href": match.target.url.href })
    }
  }

  return {
    fallback,
    features(context: MessageFallbackContext) {
      const match = identify(context.normalizedMessage, context)
      return match ? [`[media] ${{weishi:"微视",zuiyou:"最右"}[match.target.site]}分享`] : []
    },
    async dispose() {
      stopped.abort()
      cancelRecovery?.()
      await Promise.allSettled([recovery, ...downloads])
      played.clear()
    },
  }
}
