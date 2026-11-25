import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import { lockFile } from "../../../../lib/file-lock.ts"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { dataPath } from "../../core/path.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderStatusCard, renderTemplate } from "../../core/render/service.ts"
import { sendMediaFile, mediaDeliveryTooLarge, mediaDeliveryUnknown, mediaFailureMessage } from "../media/files.ts"
import { buildMediaMessageText, isMediaCommandText } from "../media/message.ts"
import { createBiliProvider } from "../subscriptions/bilibili/index.ts"
import { createSubscriptionConfig } from "../subscriptions/config.ts"
import { makeDynamicMessages } from "../subscriptions/render.ts"
import type { GetSubscriptionRedis } from "../subscriptions/types.ts"
import { ToolInstallerService } from "../tools/installer.ts"
import { biliCommentTarget, createBiliComments, type BiliComment, type BiliCommentTarget } from "./comments.ts"
import { createBiliCommentWriter } from "./comment-write.ts"
import { parseBiliPgcLink, type createBiliPgcPreview } from "./pgc.ts"
import {
  BilibiliService, biliDynamicId, biliLiveRoomId, formatBilibiliPreviewText, formatNumber, isBiliVideoPage, normalizeDownloadConfig,
  quotedBiliCardLink, resolveCommandPath,
} from "./service.ts"

export const biliFeatureNames = ["[media] B 站解析"] as const
const searchWindow = 120_000
const tukuPageSize = 42
const link = /(?:bilibili\.com|b23\.tv|bili2233\.cn|\bBV[1-9A-Za-z]{10}\b|\bav\d+\b)/iu
const searchCommand = /^#搜视频([\s\S]*)$/u
const tukuSearchCommand = /^#点(?:b|哔)站视频([\s\S]*)$/iu
const pageCommand = /^#(?:b|哔)站(上一页|下一页)$/iu
const pickCommand = /^#看(\d+)$/u
const tukuPickCommand = /^#看(?:b|哔)站视频([\s\S]*)$/iu
const watchCommand = /^#看视频([\s\S]*)$/u
const downloadCommand = /^#b站(?:下载|下视频)(?:\s+([\s\S]*))?$/iu
const quotedLinkCommand = /^#?(?:解析|解)$/u
const quotedCoverCommand = /^#?(?:下载封面|封面下载|获取封面|封面)$/u
const quotedDescriptionCommand = /^#?简介$/u
const quotedVideoCommand = /^#?(?:下载视频|视频下载|获取视频)$/u
const quotedImagesCommand = /^#?(?:获取图片|下载图片|图片)$/u
const expandCommentCommand = /^#?展开(?:\s*\+?\s*([0-9]{1,8}))?\s*$/u
const writeCommentCommand = /^#?评论([\s\S]*)$/u
const previewWindow = 30 * 60_000
const maxPreviewEntries = 512
const subscriptionSettings = createSubscriptionConfig(dataPath, lockFile)

type SearchResults = Awaited<ReturnType<BilibiliService["search"]>>
type BiliInfo = Awaited<ReturnType<BilibiliService["getInfo"]>>
type QuotedAction = "preview" | "cover" | "description" | "video" | "images"
type BiliConfig = { search_limit?: number; download?: Record<string, unknown> }
type VideoAction =
  | { kind: "search"; keyword: string; tuku: boolean }
  | { kind: "page"; next: boolean }
  | { kind: "pick"; index: number; tuku: boolean }
  | { kind: "watch"; keyword: string }
  | { kind: "comments"; index: number }
  | { kind: "write-comment"; text: string }
  | { kind: "quote"; action: QuotedAction }
  | { kind: "download" | "link"; target: string }

interface SearchSession {
  readonly keyword: string
  readonly page: number
  readonly tuku: boolean
  readonly expires: number
  readonly results: SearchResults
}

interface Discussion {
  readonly target: BiliCommentTarget
  readonly rows: readonly BiliComment[]
  readonly children?: true
}

interface Preview {
  readonly target?: string
  readonly discussion?: Discussion
}

interface Services {
  readonly signal?: AbortSignal
  readonly mediaRuntime?: { whenReady(start: () => void): () => void }
  readonly fetch?: BilibiliService["fetch"]
  readonly settings?: typeof subscriptionSettings.settings
  readonly renderComments?: typeof renderStatusCard
  readonly getRedis?: GetSubscriptionRedis
  readonly resolvedPgc?: ReturnType<typeof createBiliPgcPreview>["resolved"]
}

function videoAction(message: string, context: MessageFallbackContext): VideoAction | undefined {
  const tukuSearch = tukuSearchCommand.exec(message)
  const search = tukuSearch || searchCommand.exec(message)
  if (search) return { kind: "search", keyword: search[1]!.trim(), tuku: Boolean(tukuSearch) }
  const page = pageCommand.exec(message)
  if (page) return { kind: "page", next: page[1] === "下一页" }
  const tukuPick = tukuPickCommand.exec(message)
  const pick = tukuPick || pickCommand.exec(message)
  if (pick) {
    const input = pick[1]!.trim()
    return { kind: "pick", index: /^\d+$/u.test(input) ? Number(input) : 0, tuku: Boolean(tukuPick) }
  }
  const watch = watchCommand.exec(message)
  if (watch) return { kind: "watch", keyword: watch[1]!.trim() }
  const download = downloadCommand.exec(message)
  if (download) return { kind: "download", target: download[1]?.trim() || "" }
  const expand = expandCommentCommand.exec(message)
  if (expand) {
    return context.message_type !== "terminal" && !context.isDelegated && context.reply_id !== undefined && context.lookupReply
      ? { kind: "comments", index: Number(expand[1] ?? 1) } : undefined
  }
  const writing = writeCommentCommand.exec(message)
  if (writing) {
    return context.message_type !== "terminal" && context.reply_id !== undefined && context.lookupReply
      ? { kind: "write-comment", text: writing[1]!.trim() } : undefined
  }
  const quotedAction = quotedLinkCommand.test(message) ? "preview"
    : quotedCoverCommand.test(message) ? "cover"
    : quotedDescriptionCommand.test(message) ? "description"
    : quotedVideoCommand.test(message) ? "video"
    : quotedImagesCommand.test(message) ? "images" : undefined
  if (quotedAction) {
    if (context.message_type !== "terminal" && !context.isDelegated && context.reply_id !== undefined &&
        context.lookupReply) return { kind: "quote", action: quotedAction }
    return
  }
  if (context.message_type === "terminal" || isMediaCommandText(message)) return
  const target = buildMediaMessageText({ ...context, msg: message })
  if (link.test(target)) return { kind: "link", target }
}

function sessionKey(context: MessageFallbackContext) {
  return [context.adapter ?? "onebot", context.self_id, context.message_type, context.group_id, context.user_id].join(":")
}

function quoteScope(context: MessageFallbackContext) {
  const recipient = context.message_type === "group" ? context.group_id : context.user_id
  if (!context.self_id || !recipient || context.message_type === "terminal") return
  return [context.adapter ?? "onebot", context.self_id, context.message_type, recipient].join(":")
}

async function readOriginal(url: string, byteLimit: number, signal: AbortSignal, transport: BilibiliService["fetch"]) {
  const image = URL.parse(url)
  if (!image || image.protocol !== "https:" || image.username || image.password || image.port ||
      !["hdslb.com", "biliimg.com"].some(domain => image.hostname === domain || image.hostname.endsWith("." + domain))) return
  try {
    const response = await transport(image.href, {
      credentials: "omit", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    })
    if (!response.ok || !response.body || response.redirected ||
        !/^image\/(?:jpeg|png|webp|gif)(?:;|$)/iu.test(response.headers.get("content-type") ?? "") ||
        Number(response.headers.get("content-length")) > byteLimit) {
      await response.body?.cancel()
      return
    }
    const pieces = []
    let size = 0
    for await (const piece of response.body) {
      size += piece.byteLength
      if (size > byteLimit) return
      pieces.push(piece)
    }
    if (size && !signal.aborted) return Buffer.concat(pieces, size)
  } catch { return }
}

export function createBilibiliVideoCommands({ signal, mediaRuntime, fetch, settings = subscriptionSettings.settings,
  renderComments = renderStatusCard, resolvedPgc,
  getRedis = () => (globalThis as { redis?: ReturnType<GetSubscriptionRedis> }).redis }: Services) {
  const sessions = new Map<string, SearchSession>()
  const previews = new Map<string, Preview & { expires: number }>()
  const comments = createBiliComments(fetch)
  const postComment = createBiliCommentWriter(fetch, getRedis)
  const request = fetch ?? globalThis.fetch
  const running = new Set<string>()
  let recovery: Promise<unknown> | undefined
  const cancelRecovery = mediaRuntime?.whenReady(() => {
    if (signal?.aborted) return
    recovery = new BilibiliService().recoverTasks().catch(error => {
      console.warn($t("services.bilibili.video-command.text_9b422b0968") + error.message)
    })
  })

  function reply(context: MessageFallbackContext, ...args: Parameters<MessageFallbackContext["reply"]>) {
    return signal?.aborted ? false : context.reply(...args)
  }

  async function imageReply(context: MessageFallbackContext, image: Uint8Array | undefined, fallback: string,
    options?: Parameters<MessageFallbackContext["reply"]>[2]) {
    if (signal?.aborted) return
    if (!image || !await reply(context, { type: "image", file: image }, undefined, options)) await reply(context, fallback, undefined, options)
  }

  function previewReceipt(context: MessageFallbackContext, preview: Preview) {
    const scope = quoteScope(context)
    if (!scope || (!preview.target && !preview.discussion)) return
    return { onDelivered(messageId: number) {
      if (signal?.aborted || !Number.isSafeInteger(messageId)) return
      if (previews.size >= maxPreviewEntries) previews.delete(previews.keys().next().value!)
      previews.set(scope + ":" + messageId, { ...preview, expires: Date.now() + previewWindow })
    } }
  }

  async function quotedTarget(context: MessageFallbackContext, cardOnly = false) {
    if (context.isDelegated || signal?.aborted || context.reply_id === undefined) return
    const source = await context.lookupReply?.().catch(() => undefined)
    const card = source?.message[0]
    if (!source || signal?.aborted) return
    if (card?.type === "json" || card?.type === "light_app") return quotedBiliCardLink(card.data) ?? undefined
    if (cardOnly) return
    return receivedPreview(context, source.user_id)?.target
  }

  function receivedPreview(context: MessageFallbackContext, author: number) {
    const scope = quoteScope(context)
    if (!scope || author !== context.self_id) return
    const preview = previews.get(scope + ":" + context.reply_id)
    if (preview && preview.expires > Date.now()) return preview
  }

  function commentSignal(context: MessageFallbackContext) {
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
    return connection && signal ? AbortSignal.any([connection, signal]) : connection ?? signal
  }

  async function discussionFor(target: BiliCommentTarget | undefined, context: MessageFallbackContext): Promise<Discussion | undefined> {
    if (!target || !quoteScope(context) || context.isDelegated) return
    try {
      const rows = await comments.firstPage(target, commentSignal(context))
      if (rows.length) return { target, rows }
    } catch { /* Comment availability is independent of the preview. */ }
  }

  async function showDiscussion(context: MessageFallbackContext, preview: Preview, title: string, parent?: BiliComment) {
    const rows = preview.discussion?.rows ?? []
    const active = commentSignal(context)
    if (active?.aborted) return
    const items = rows.map((row, index) => {
      const characters = Array.from(`${row.text}${row.images.length ? $t("services.bilibili.video-command.text_fc91a0bbf6") : ""}`.trim())
      return { label: `${index + 1}. ${row.author}${row.pinned ? $t("services.bilibili.video-command.text_7759a425b7") : ""}`,
        value: characters.length > 100 ? characters.slice(0, 100).join("") + "…" : characters.join("") }
    })
    const hint = items.length ? $t("services.bilibili.video-command.text_e71dacf209") : ""
    const rootText = parent ? `${parent.author}\n${parent.text}` : undefined
    const card = { title, message: [rootText, hint].filter(Boolean).join("\n"), userId: context.user_id, items }
    const fallback = [title, rootText, ...items.map(item => `${item.label}\n${item.value}`), hint].filter(Boolean).join("\n\n")
    let image = await renderComments(card).catch(() => undefined)
    const limit = context.inlineImageByteLimit ?? 16 * 1024 * 1024
    if (image && image.byteLength > limit && Number(Bun.env.LOTUS_RENDER_SCALE ?? 4) > 2) {
      image = await renderComments(card, { renderScale: 2 }).catch(() => undefined)
    }
    if (active?.aborted) return
    const receipt = previewReceipt(context, preview)
    if (!image || image.byteLength > limit || !await reply(context, { type: "image", file: image }, undefined, receipt)) {
      if (!active?.aborted) await reply(context, fallback, undefined, receipt)
    }
    if (parent?.images.length && !active?.aborted) await sendOriginals(context, parent.images, request, active)
  }

  async function expandComment(context: MessageFallbackContext, index: number) {
    const options = await settings("bilibili")
    const active = commentSignal(context)
    if (!options.parseVideoLink || active?.aborted) return
    const source = await context.lookupReply?.().catch(() => undefined)
    if (!source || active?.aborted) return
    const preview = receivedPreview(context, source.user_id)
    if (!preview) return
    const discussion = preview.discussion
    if (!discussion?.rows.length) return $t("services.bilibili.video-command.text_c780ea699e")
    const selected = discussion.rows[index - 1]
    if (!selected) return $t("services.bilibili.video-command.text_787dd2c120", { "length": discussion.rows.length })
    if (discussion.children) {
      await showDiscussion(context, {}, $t("services.bilibili.video-command.text_51f2401b3b"), selected)
      return []
    }
    let rows: readonly BiliComment[] = []
    try { rows = await comments.thread(discussion.target, selected.id, active) }
    catch { if (!active?.aborted) return $t("services.bilibili.video-command.text_c0b6ef1c29") }
    await showDiscussion(context, { discussion: { ...discussion, rows, children: true } }, $t("services.bilibili.video-command.text_10c8925238"), selected)
    return []
  }

  async function writeComment(context: MessageFallbackContext, text: string) {
    const user = context.user_id
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
    if (context.isDelegated || user === undefined || !connection || !context.isBotMaster(user)) return
    const active = signal ? AbortSignal.any([signal, connection]) : connection
    if (active.aborted || !(await settings("bilibili")).parseVideoLink) return
    const target = await quotedTarget(context)
    const url = target && URL.parse(target)
    if (!url || active.aborted) return
    if (!text || Array.from(text).length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
      return $t("services.bilibili.video-command.text_9d01eb5c2d")
    }
    return postComment(url, text, context, active)
  }

  async function sendOriginals(context: MessageFallbackContext, sources: readonly string[], transport: BilibiliService["fetch"],
    active = signal ?? new AbortController().signal) {
    const limit = Math.min(context.inlineImageByteLimit ?? Infinity, 8 * 1024 ** 2)
    let sent = 0
    for (const url of [...new Set(sources)].slice(0, 9)) {
      if (active.aborted) return []
      const bytes = await readOriginal(url, limit, active, transport)
      if (bytes && await reply(context, { type: "image", file: bytes })) sent++
    }
    return sent ? [] : $t("services.bilibili.video-command.text_eb7e6e1756")
  }

  async function reportError(context: MessageFallbackContext, title: string, cause: unknown) {
    if (signal?.aborted) return
    const error = cause as Error & { code?: string }
    const message = error instanceof Error ? error.message : $t("services.bilibili.video-command.text_8977b79aa8")
    const diskFull = error?.code === "ENOSPC" || error?.code === "EDQUOT" || /No space left on device|Disk quota exceeded/iu.test(message)
    const detail = diskFull ? $t("services.bilibili.video-command.text_1aa1d82019") : message
    const unconfirmed = error?.code === mediaDeliveryUnknown
    const fallback = unconfirmed || diskFull || error?.code === mediaDeliveryTooLarge ? detail : $t("services.bilibili.video-command.text_491921973e", { "title": title })
    const image = await renderStatusCard({
      title, subtitle: $t("services.bilibili.video-command.text_7f5440b5cf"), badge: unconfirmed ? $t("services.bilibili.video-command.text_c098e854e6") : $t("services.bilibili.video-command.text_28384d7afd"),
      message: detail,
      userId: context.user_id,
      items: unconfirmed ? [] : [
        { label: $t("services.bilibili.video-command.text_abee497473"), value: diskFull ? $t("services.bilibili.video-command.text_68ebf9d47c") : $t("services.bilibili.video-command.text_97b575de6d") },
      ],
    }, { saveId: `media-bilibili-error-${context.user_id || "user"}` }).catch(() => undefined)
    await imageReply(context, image, `${fallback}`)
  }

  function currentSession(key: string) {
    const session = sessions.get(key)
    if (session && session.expires > Date.now()) return session
    sessions.delete(key)
  }

  async function showSearch(context: MessageFallbackContext, service: BilibiliService, key: string,
    keyword: string, page: number, tuku: boolean) {
    if (running.has(key)) return $t("services.bilibili.video-command.text_a054c4b8eb")
    running.add(key)
    try {
      if (tuku) await reply(context, $t("services.bilibili.video-command.text_4f31e957b1"))
      if (signal?.aborted) return []
      const results = await service.search(keyword, { page, signal: commentSignal(context), ...(tuku && { limit: tukuPageSize }) })
      if (signal?.aborted) return []
      if (page > 1 && !results.length) return $t("services.bilibili.video-command.text_c1edfcf4d4")
      const message = results.length
        ? tuku ? $t("services.bilibili.video-command.text_a58246ae84", { "page": page }) : $t("services.bilibili.video-command.text_eb460db326")
        : $t("services.bilibili.video-command.text_86c8c8064e")
      const items = results.map((item, index) => ({
        label: tuku ? $t("services.bilibili.video-command.text_0675556447", { "value1": index + 1 }) : `#看${index + 1}`,
        value: `${item.title} · ${item.author || $t("services.bilibili.video-command.text_4d8c1c5b42")} · ${formatNumber(item.play)}`,
      }))
      const now = Date.now()
      for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id)
      sessions.set(key, { expires: now + searchWindow, keyword, page, tuku, results })
      const image = await renderStatusCard({
        title: $t("services.bilibili.video-command.text_442d83ee94"), subtitle: keyword,
        badge: tuku ? $t("services.bilibili.video-command.text_7d392b71c1", { "page": page, "length": results.length }) : String(results.length),
        message, userId: context.user_id, items,
      }, { saveId: `media-bilibili-search-${context.user_id || "user"}` })
      await imageReply(context, image, $t("services.bilibili.video-command.text_a89cf4fc5f"))
    } catch (error) {
      await reportError(context, $t("services.bilibili.video-command.text_442d83ee94"), error)
    } finally {
      running.delete(key)
    }
    return []
  }

  async function renderInfo(context: MessageFallbackContext, service: BilibiliService, info: BiliInfo, download = true) {
    const image = await renderTemplate("bilibili-info", {
      type: info.type,
      title: info.title, owner: info.owner, cover: info.cover,
      desc: info.desc, userId: context.user_id,
      ...(info.type === "live" ? {
        id: `直播间 ${info.roomId}`, liveStatus: info.liveStatus, online: info.online, stat: {},
      } : { id: info.bvid, duration: info.duration, stat: info.stat || {} }),
    }, { saveId: `media-bilibili-${context.user_id || "user"}` }).catch(error => {
      console.warn($t("services.bilibili.video-command.text_3e0a85193a") + error.message)
    })
    const discussion = info.type === "video" && info.stat.reply !== 0
      ? await discussionFor(biliCommentTarget(info.aid, 1), context) : undefined
    const preview = info.type === "video" ? { target: info.url, discussion } : undefined
    const receipt = preview && previewReceipt(context, preview)
    if (!image && info.type === "video") await reply(context, formatBilibiliPreviewText(info), undefined, receipt)
    else await imageReply(context, image || undefined, $t("services.bilibili.video-command.text_3218cf73b0"), receipt)
    if (signal?.aborted) return
    if (discussion && preview) await showDiscussion(context, preview, $t("services.bilibili.video-command.text_39028a915f"))
    if (info.type === "live" && info.playerUrl) {
      await reply(context, $t("services.bilibili.video-command.text_bad0d56016") + info.playerUrl)
    } else if (info.type === "video" && info.url && download) {
      await runDownload(context, service, info.url, $t("services.bilibili.video-command.text_cdd1bbf155"))
    }
  }

  async function runDownload(context: MessageFallbackContext, service: BilibiliService, target: string, title: string): Promise<void> {
    const active = commentSignal(context)
    let result: Awaited<ReturnType<BilibiliService["download"]>> | undefined
    try {
      await recovery
      if (active?.aborted) return
      const config = await loadGlobalConfig()
      const permissions = new PermissionService({ permissions: config.permissions })
      const subject = context.canManagePackages ? { ...context, isMaster: true } : context
      if (!permissions.explain(subject, "bilibili.download").ok) throw new Error($t("services.bilibili.video-command.text_a9c966feb5"))
      const bilibili = config.bilibili as BiliConfig
      const settings = { ...bilibili, ...bilibili.download }
      const download = normalizeDownloadConfig(settings)
      if (!download.enable) throw new Error($t("services.bilibili.video-command.text_7f86f2569d"))
      const installed = await Promise.all(["ffmpeg", "ffprobe"].map(name => resolveCommandPath(name, download.tools_path)))
      if (active?.aborted) return
      // Requests with working local tools do not wait for remote version checks.
      if (context.canManagePackages && permissions.explain(subject, "tools.install").ok && installed.some(file => !file)) {
        const tools = await new ToolInstallerService({ config: config.tools }).ensureAll()
        if (!tools.ok) {
          const failures = tools.items?.filter(item => !item.ok).map(item => `${item.name}:${item.reason}`).join(" / ")
          throw new Error($t("services.bilibili.video-command.text_4bc90272ca") + (failures || "unknown"))
        }
      }
      if (active?.aborted) return
      result = await service.download(target, settings, {
        signal: active,
        onEvent: event => {
          console.debug($t("services.bilibili.video-command.text_415d23f772") + event.message)
        },
      })
      if (active?.aborted) return
      if (!result.ok) {
        if (result.reason === "live_download_unsupported") {
          return renderInfo(context, service, result.info, false)
        }
        throw new Error(mediaFailureMessage(result))
      }
      for (const file of result.files) {
        if (active?.aborted) return
        await sendMediaFile({ ...context, reply: (...args: Parameters<MessageFallbackContext["reply"]>) => reply(context, ...args) },
          file, { ...download, file_name: result.fileNames[file], signal: active })
      }
    } catch (error) {
      if (!active?.aborted) await reportError(context, title, error)
    } finally {
      if (result?.ok) {
        await service.releaseTask(result).catch(error => {
          console.warn($t("services.bilibili.video-command.text_32013e6ece") + error.message)
        })
      }
    }
  }

  const fallback: MessageFallback = async (message, context) => {
    if (signal?.aborted) return
    const action = videoAction(message, context)
    if (!action) return
    if (action.kind === "comments") return expandComment(context, action.index)
    if (action.kind === "write-comment") return writeComment(context, action.text)
    const key = sessionKey(context)
    const session = currentSession(key)
    if (action.kind === "page" && !session?.tuku) return $t("services.bilibili.video-command.text_d90eae7174")
    if (action.kind === "pick" && !session) {
      return action.tuku ? $t("services.bilibili.video-command.text_cbf586658d") : undefined
    }
    if (action.kind === "download" && !action.target) return $t("services.bilibili.video-command.text_749b1a5f23")
    const config = await loadGlobalConfig()
    const service = new BilibiliService({ fetch, tuneweaveConfig: config.tuneweave, searchLimit: (config.bilibili as BiliConfig).search_limit })
    switch (action.kind) {
      case "search":
        if (!action.keyword) return $t("services.bilibili.video-command.text_b708871132")
        return showSearch(context, service, key, action.keyword, 1, action.tuku)
      case "page":
        if (!session) return
        if (!action.next && session.page === 1) return $t("services.bilibili.video-command.text_84210ffe50")
        return showSearch(context, service, key, session.keyword, session.page + (action.next ? 1 : -1), true)
      case "download":
        await runDownload(context, service, action.target, $t("services.bilibili.video-command.text_08458c593a"))
        return []
    }
    let target: string
    let informationUrl: string | undefined
    try {
      if (action.kind === "pick") {
        const item = session!.results[action.index - 1]
        if (!item) return session!.results.length ? $t("services.bilibili.video-command.text_18f43e7832", { "length": session!.results.length }) : $t("services.bilibili.video-command.text_9f9c8bf140")
        if (action.tuku) await reply(context, $t("services.bilibili.video-command.text_2d36952dc2"))
        target = item.url
      } else if (action.kind === "watch") {
        if (!action.keyword) return $t("services.bilibili.video-command.text_c9df43d930")
        const [first] = await service.search(action.keyword, { limit: 1, signal: commentSignal(context) })
        if (!first) throw new Error($t("services.bilibili.video-command.text_efe6058d6e"))
        target = first.url
      } else {
        let options: Awaited<ReturnType<typeof settings>> | undefined
        if (action.kind === "quote") {
          options = await settings("bilibili")
          if (!options.parseVideoLink || signal?.aborted) return
          target = await quotedTarget(context, action.action === "preview") || ""
        } else {
          // A foreign share card cannot suppress a separately typed Bilibili link.
          target = service.extractTarget(action.target) ?? service.extractTarget(message) ?? ""
        }
        if (!target) return
        const url = URL.parse(target)
        if (!url || !biliLiveRoomId(url)) {
          options ??= await settings("bilibili")
          if (!options.parseVideoLink || signal?.aborted) return
          const active = commentSignal(context)
          if (active?.aborted) return
          const destination = url && service.resolveShortLink(url, active)
          const resolved = await (action.kind === "quote" ? destination?.catch(() => undefined) : destination)
          const pgc = resolvedPgc && resolved && parseBiliPgcLink(resolved.href)
          if (resolvedPgc && pgc) {
            if (action.kind === "quote" && action.action !== "preview") return
            return resolvedPgc(pgc, context, action.kind === "quote" ? "quote" : "share")
          }
          const id = resolved && biliDynamicId(resolved)
          if (id) {
            const provider = createBiliProvider({ fetch })
            const post = await provider.fetchPost(id, active)
            if (active?.aborted) return
            if (!post) return $t("services.bilibili.video-command.text_72ee3d3616")
            if (action.kind === "quote" && action.action === "images") {
              return sendOriginals(context, [...post.images, ...(post.forwarded?.images ?? [])], service.fetch, active)
            }
            if (action.kind === "quote" && action.action !== "preview") return
            const discussion = post.activity?.comments !== "0" ? await discussionFor(post.commentTarget, context) : undefined
            const preview = { target: resolved.href, discussion }
            const messages = await makeDynamicMessages(provider, post, options,
              { signal: active, inlineImageByteLimit: context.inlineImageByteLimit, preview: true })
            for (const message of messages) await reply(context, message, undefined, previewReceipt(context, preview))
            if (discussion) await showDiscussion(context, preview, $t("services.bilibili.video-command.text_39028a915f"))
            return []
          }
          if (action.kind === "quote" && (!resolved || !isBiliVideoPage(resolved))) return
          informationUrl = resolved?.href
        }
      }
      if (signal?.aborted) return
      if (action.kind === "quote" && action.action === "video") {
        if (!informationUrl || !isBiliVideoPage(new URL(informationUrl))) return
        await runDownload(context, service, informationUrl, $t("services.bilibili.video-command.text_08458c593a"))
        return []
      }
      const info = await service.getInfo(informationUrl ?? target, commentSignal(context))
      if (signal?.aborted) return
      if (action.kind === "quote" && action.action !== "preview") {
        if (info.type !== "video") return
        if (action.action === "cover") return sendOriginals(context, info.cover ? [info.cover] : [], service.fetch)
        if (action.action === "description") return info.description.trim().slice(0, 3000) || $t("services.bilibili.video-command.text_2dc5fa6ff0")
        return
      }
      await renderInfo(context, service, info, action.kind !== "quote")
    } catch (error) {
      if (!commentSignal(context)?.aborted) await reportError(context, action.kind === "watch" ? $t("services.bilibili.video-command.text_7228d2c9ff") : $t("services.bilibili.video-command.text_3e8934a646"), error)
    }
    return []
  }
  return {
    fallback,
    async quotedAuthor(context: MessageFallbackContext) {
      const target = await quotedTarget(context)
      const url = target && URL.parse(target)
      if (!url || signal?.aborted) return
      const config = await loadGlobalConfig()
      const service = new BilibiliService({ fetch, tuneweaveConfig: config.tuneweave })
      const resolved = await service.resolveShortLink(url, signal)
      if (!isBiliVideoPage(resolved)) return
      const info = await service.getInfo(resolved.href, commentSignal(context))
      if (info.type === "video" && !signal?.aborted) return info.ownerId
    },
    features(context: MessageFallbackContext) {
      return videoAction(context.normalizedMessage, context) ? biliFeatureNames : []
    },
    async dispose() {
      cancelRecovery?.()
      sessions.clear()
      previews.clear()
      await recovery
    },
  }
}
