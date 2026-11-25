import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { load } from "cheerio"
import { join } from "node:path"
import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import type { MessageReply } from "../../../../lib/messages.ts"
import { requestOfficialJson } from "../../../../packages/hoyo-client/redeem-preview/http.ts"
import { renderSourceCard } from "../../core/render/source-cards.ts"
import { resolveData } from "../../core/path.ts"
import { isMiyousheVideoUrl, type MediaFetch } from "../media/cdn.ts"
import { downloadMedia } from "../media/download.ts"
import { mediaDeliveryUnknown, safeMediaName, sendMediaFile } from "../media/files.ts"
import { articlePages, buildMediaMessageText, isMediaCommandText, type ArticleBlock } from "../media/message.ts"
import { createMediaTask, recoverMediaTasks, releaseMediaTask } from "../media/tasks.ts"

const link = /(?<=^|[\s"'([{>：，。])https?:\/\/(?:www\.|m\.)?miyoushe\.com\/[a-z0-9]+\/article\/([1-9]\d{0,17})(?=$|[\s"'\])}<>,.?/#&，。！？；：])/iu
const imagesHosts = new Set(["upload-bbs.miyoushe.com", "upload-bbs.mihoyo.com"])
const videoLimit = 100 * 1024 * 1024
const holdMs = 10 * 60_000

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, length: number) {
  return typeof value === "string" ? Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim()).slice(0, length).join("") : ""
}

function sourceUrl(value: unknown) {
  const url = typeof value === "string" && value.length <= 2048 ? URL.parse(value) : undefined
  if (url?.protocol === "https:" && !url.username && !url.password && !url.port) return url
}

function picture(value: unknown) {
  const url = sourceUrl(value)
  if (url && imagesHosts.has(url.hostname)) return url.href
}

function contentBlocks(post: Record<string, unknown>) {
  const blocks: ArticleBlock[] = []
  const seen = new Set<string>()
  function pushPicture(value: unknown) {
    const url = picture(value)
    if (!url || seen.has(url) || seen.size >= 20) return
    seen.add(url)
    blocks.push({ type: "image", urls: [url] })
  }
  let remaining = 6000
  function pushText(value: unknown) {
    const body = text(value, remaining)
    if (!body) return
    remaining -= Array.from(body).length
    blocks.push({ type: "text", text: body })
  }
  if (typeof post.structured_content === "string" && post.structured_content.length <= 120_000) {
    try {
      const rows: unknown = JSON.parse(post.structured_content)
      if (Array.isArray(rows)) {
        let paragraph = ""
        for (const raw of rows.slice(0, 500)) {
          const insert = record(raw).insert
          if (typeof insert === "string") paragraph += insert
          else {
            pushText(paragraph)
            paragraph = ""
            pushPicture(record(insert).image)
          }
        }
        pushText(paragraph)
      }
    } catch { /* Use the post's plain content when delta is unavailable. */ }
  }
  if (!blocks.some(block => block.type === "text") && typeof post.content === "string" && post.content.length <= 120_000) {
    try { pushText(record(JSON.parse(post.content)).describe) }
    catch {
      const document = load(post.content, undefined, false)
      document("script,style").remove()
      document("br").replaceWith("\n")
      document("p,li").append("\n")
      pushText(document.root().text())
    }
  }
  if (Array.isArray(post.images)) for (const url of post.images.slice(0, 20)) pushPicture(url)
  return blocks
}

export function createMiyoushePostCommands({ signal: lifecycle, mediaRuntime, request = requestOfficialJson,
  render = renderSourceCard, fetchVideo, tasksDir = resolveData("miyoushe", "tasks") }: {
  readonly signal?: AbortSignal
  readonly mediaRuntime?: { whenReady(start: () => void): () => void }
  readonly request?: typeof requestOfficialJson
  readonly render?: typeof renderSourceCard
  readonly fetchVideo?: MediaFetch
  readonly tasksDir?: string
} = {}) {
  const stopped = new AbortController()
  const signal = lifecycle ? AbortSignal.any([lifecycle, stopped.signal]) : stopped.signal
  const deliveries = new Map<string, number>()
  const work = new Set<Promise<void>>()
  let recovery: Promise<unknown> | undefined
  const cancelRecovery = mediaRuntime?.whenReady(() => {
    if (!signal.aborted) recovery = recoverMediaTasks(tasksDir).catch(() => console.warn($t("services.official-video.post-command.text_b4ceef2312")))
  })

  function identify(message: string, context: MessageFallbackContext) {
    if (signal?.aborted || context.isDelegated || context.message_type === "terminal" || isMediaCommandText(message)) return
    return link.exec(buildMediaMessageText({ ...context, msg: message }))
  }

  function videoDelivery(video: URL, title: string, context: MessageFallbackContext) {
    if (!context.forward || !context.deliverMedia) return
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
    const active = connection ? AbortSignal.any([signal, connection]) : signal
    const peer = context.message_type === "group" ? context.group_id : context.user_id
    const key = context.message_id === undefined ? undefined :
      [context.adapter ?? "onebot", context.self_id, context.message_type, peer, context.message_id].join(":")
    let attempted = false
    return async () => {
      if (attempted || active.aborted) return
      attempted = true
      if (key) {
        const now = Date.now()
        for (const [old, expires] of deliveries) {
          if (expires > now) break
          deliveries.delete(old)
        }
        if (deliveries.has(key)) return
        if (deliveries.size >= 4096) deliveries.delete(deliveries.keys().next().value!)
        deliveries.set(key, now + holdMs)
      }
      const pending = sendVideo(video, title, context, active)
      work.add(pending)
      try { await pending } finally { work.delete(pending) }
    }
  }

  async function sendVideo(video: URL, title: string, context: MessageFallbackContext, active: AbortSignal) {
    let task: Awaited<ReturnType<typeof createMediaTask>> | undefined
    try {
      await recovery
      active.throwIfAborted()
      task = await createMediaTask(tasksDir)
      const { file } = await downloadMedia(video.href, join(task.dir, "video"), {
        fetch: fetchVideo, kind: "video", cdn: "miyoushe-video", maxBytes: videoLimit, timeoutMs: 60_000,
        headers: { Referer: "https://www.miyoushe.com/" }, signal: active,
      })
      await sendMediaFile(context, file, { file_name: safeMediaName(title) + file.slice(file.lastIndexOf(".")), signal: active })
    } catch (error) {
      if (!active.aborted) {
        const unknown = error instanceof Error && "code" in error && error.code === mediaDeliveryUnknown
        try { await context.reply(unknown ? $t("services.official-video.post-command.text_a70a783e34") : $t("services.official-video.post-command.text_419dfd1d18")) }
        catch { /* The original connection may have closed after delivery. */ }
      }
    } finally {
      if (task) await releaseMediaTask(tasksDir, task.dir).catch(() => console.warn($t("services.official-video.post-command.text_43bb146fc1")))
    }
  }

  async function fallback(message: string, context: MessageFallbackContext) {
    const matched = identify(message, context)
    if (!matched?.[1]) return
    const id = matched[1]
    const source = new URL(matched[0])
    source.protocol = "https:"
    const target = new URL("https://bbs-api.mihoyo.com/post/wapi/getPostFull")
    target.search = new URLSearchParams({ post_id: id, read: "0" }).toString()
    try {
      const response = record(await request(target, { signal, headers: { Accept: "application/json", Referer: "https://www.miyoushe.com/" } }))
      const entry = record(record(response.data).post)
      const post = record(entry.post)
      if (response.retcode !== 0 || String(post.post_id) !== id) return $t("services.official-video.post-command.text_0767e25797")
      const owner = text(record(entry.user).nickname, 80)
      const title = text(post.subject, 160) || $t("services.official-video.post-command.text_01561ca799")
      const blocks = contentBlocks(post)
      const cover = picture(post.cover)
      if (cover && !blocks.some(block => block.urls?.includes(cover))) blocks.unshift({ type: "image", urls: [cover] })
      const pages = articlePages({ blocks })
      const intro = `${title}\n${[owner, source.href].filter(Boolean).join("\n")}`
      const nodes: MessageReply[] = [intro]
      const inlineLimit = context.inlineImageByteLimit ?? 16 * 1024 * 1024
      for (const [index, page] of pages.entries()) {
        signal?.throwIfAborted()
        const original = page[0]?.type === "image" ? page[0].urls?.[0] : undefined
        const card = { title, owner, page: index + 1, blocks: page }
        let image = await render("article", card).catch(() => undefined)
        if (image && image.byteLength > inlineLimit && Number(Bun.env.LOTUS_RENDER_SCALE ?? 4) > 2) {
          image = await render("article", card, { renderScale: 2 }).catch(() => undefined)
        }
        if (image && image.byteLength <= inlineLimit) nodes.push(original ? [{ type: "image", file: image }, $t("services.official-video.post-command.text_fd04ac0732", { "original": original })] : { type: "image", file: image })
        else nodes.push(page.map(block => block.text ?? block.urls?.join("\n")).filter(Boolean).join("\n"))
      }
      const videos = Array.isArray(entry.vod_list) ? entry.vod_list : []
      const resolutions = record(videos[0]).resolutions
      const video = Array.isArray(resolutions) ? resolutions.map(row => sourceUrl(record(row).url)).find(url => url && isMiyousheVideoUrl(url)) : undefined
      if (video) nodes.push($t("services.official-video.post-command.text_22f5fe65cc", { "href": video.href }))
      signal?.throwIfAborted()
      const onDelivered = video && videoDelivery(video, title, context)
      return nodes.length > 1 ? { type: "forward" as const, nodes, ...(onDelivered && { onDelivered }) } : intro
    } catch { if (!signal?.aborted) return $t("services.official-video.post-command.text_e4bd695ca0") }
  }

  return {
    fallback,
    features: (context: MessageFallbackContext) => identify(context.normalizedMessage, context) ? ["[media] 米游社帖子"] : [],
    async dispose() {
      stopped.abort()
      cancelRecovery?.()
      await Promise.allSettled([recovery, ...work])
      deliveries.clear()
    },
  }
}
