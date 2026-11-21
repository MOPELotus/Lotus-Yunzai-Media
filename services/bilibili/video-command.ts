import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import { lockFile } from "../../../../lib/file-lock.ts"
import { loadGlobalConfig } from "../../core/config/global.js"
import { dataPath } from "../../core/path.js"
import { PermissionService } from "../../core/permissions/service.js"
import { renderStatusCard, renderTemplate } from "../../core/render/service.js"
import { sendMediaFile, mediaDeliveryUnknown, mediaFailureMessage } from "../media/files.ts"
import { buildMediaMessageText, isMediaCommandText } from "../media/message.ts"
import { createSubscriptionConfig } from "../subscriptions/config.js"
import { ToolInstallerService } from "../tools/installer.js"
import {
  BilibiliService, formatBilibiliPreviewText, formatNumber, normalizeDownloadConfig, resolveCommandPath,
} from "./service.ts"

const featureNames = ["[media] B 站解析"] as const
const searchWindow = 120_000
const tukuPageSize = 42
const link = /(?:bilibili\.com|b23\.tv|bili2233\.cn|\bBV[1-9A-Za-z]{10}\b|\bav\d+\b)/iu
const searchCommand = /^#搜视频([\s\S]*)$/u
const tukuSearchCommand = /^#点(?:b|哔)站视频([\s\S]*)$/iu
const pageCommand = /^#(?:b|哔)站(上一页|下一页)$/iu
const pickCommand = /^#看(\d+)$/u
const tukuPickCommand = /^#看(?:b|哔)站视频([\s\S]*)$/iu
const watchCommand = /^#看视频([\s\S]*)$/u
const downloadCommand = /^#b站(?:下载|下视频)\s+([\s\S]+)$/iu
const subscriptionSettings = createSubscriptionConfig(dataPath, lockFile)

type SearchResults = Awaited<ReturnType<BilibiliService["search"]>>
type BiliInfo = Awaited<ReturnType<BilibiliService["getInfo"]>>
type BiliConfig = { search_limit?: number; download?: Record<string, unknown> }
type VideoAction =
  | { kind: "search"; keyword: string; tuku: boolean }
  | { kind: "page"; next: boolean }
  | { kind: "pick"; index: number; tuku: boolean }
  | { kind: "watch"; keyword: string }
  | { kind: "download" | "link"; target: string }

interface SearchSession {
  readonly keyword: string
  readonly page: number
  readonly tuku: boolean
  readonly expires: number
  readonly results: SearchResults
}

interface Services {
  readonly signal?: AbortSignal
  readonly mediaRuntime?: { whenReady(start: () => void): () => void }
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
  if (download) return { kind: "download", target: download[1]!.trim() }
  if (context.message_type === "terminal" || isMediaCommandText(message)) return
  const target = buildMediaMessageText({ ...context, msg: message })
  if (link.test(target)) return { kind: "link", target }
}

function sessionKey(context: MessageFallbackContext) {
  return [context.self_id, context.message_type, context.group_id, context.user_id].join(":")
}

export function createBilibiliVideoCommands({ signal, mediaRuntime }: Services) {
  const sessions = new Map<string, SearchSession>()
  const running = new Set<string>()
  let recovery: Promise<unknown> | undefined
  const cancelRecovery = mediaRuntime?.whenReady(() => {
    if (signal?.aborted) return
    recovery = new BilibiliService().recoverTasks().catch(error => {
      console.warn("[media] B 站任务恢复失败：" + error.message)
    })
  })

  function reply(context: MessageFallbackContext, ...args: Parameters<MessageFallbackContext["reply"]>) {
    return signal?.aborted ? false : context.reply(...args)
  }

  async function imageReply(context: MessageFallbackContext, image: Uint8Array | undefined, fallback: string) {
    if (signal?.aborted) return
    if (!image || !await reply(context, { type: "image", file: image })) await reply(context, fallback)
  }

  async function reportError(context: MessageFallbackContext, title: string, cause: unknown) {
    if (signal?.aborted) return
    const error = cause as Error & { code?: string }
    const message = error instanceof Error ? error.message : "请求失败，请稍后重试。"
    const diskFull = error?.code === "ENOSPC" || error?.code === "EDQUOT" || /No space left on device|Disk quota exceeded/iu.test(message)
    const image = await renderStatusCard({
      title, subtitle: "Lotus-Yunzai · B 站", badge: "失败",
      message: diskFull ? "服务器磁盘空间不足，暂时无法下载或合并视频。" : message,
      userId: context.user_id,
      items: error?.code === mediaDeliveryUnknown ? [] : [
        { label: "建议", value: diskFull ? "请联系机器人主人清理磁盘空间后重试。" : "检查链接是否有效，或稍后重试。" },
      ],
    }, { saveId: `media-bilibili-error-${context.user_id || "user"}` }).catch(() => undefined)
    await imageReply(context, image, `[media] ${title}失败。`)
  }

  function currentSession(key: string) {
    const session = sessions.get(key)
    if (session && session.expires > Date.now()) return session
    sessions.delete(key)
  }

  async function showSearch(context: MessageFallbackContext, service: BilibiliService, key: string,
    keyword: string, page: number, tuku: boolean) {
    if (running.has(key)) return "[media] 当前 B 站搜索正在进行。"
    running.add(key)
    try {
      if (tuku) await reply(context, "好的，正在搜索")
      if (signal?.aborted) return []
      const results = await service.search(keyword, tuku ? { page, limit: tukuPageSize } : { page })
      if (signal?.aborted) return []
      if (page > 1 && !results.length) return "[media] 已经没有下一页了。"
      const message = results.length
        ? tuku ? `第 ${page} 页 · 两分钟内可翻页，或发送 #看B站视频 1 选择结果。` : "两分钟内发送 #看1 这类序号继续解析。"
        : "没有搜索到相关视频。"
      const items = results.map((item, index) => ({
        label: tuku ? `#看B站视频 ${index + 1}` : `#看${index + 1}`,
        value: `${item.title} · ${item.author || "未知"} · ${formatNumber(item.play)}`,
      }))
      const now = Date.now()
      for (const [id, session] of sessions) if (session.expires <= now) sessions.delete(id)
      sessions.set(key, { expires: now + searchWindow, keyword, page, tuku, results })
      const image = await renderStatusCard({
        title: "B站搜索", subtitle: keyword,
        badge: tuku ? `第 ${page} 页 · ${results.length} 条` : String(results.length),
        message, userId: context.user_id, items,
      }, { saveId: `media-bilibili-search-${context.user_id || "user"}` })
      await imageReply(context, image, "[media] B站搜索完成。")
    } catch (error) {
      await reportError(context, "B站搜索", error)
    } finally {
      running.delete(key)
    }
    return []
  }

  async function renderInfo(context: MessageFallbackContext, service: BilibiliService, info: BiliInfo, target?: string, download = true) {
    const image = await renderTemplate("bilibili-info", {
      type: info.type,
      title: info.title, owner: info.owner, cover: info.cover,
      desc: info.desc, userId: context.user_id,
      ...(info.type === "live" ? {
        id: `直播间 ${info.roomId}`, liveStatus: info.liveStatus, online: info.online, stat: {},
      } : { id: info.bvid, duration: info.duration, stat: info.stat || {} }),
    }, { saveId: `media-bilibili-${context.user_id || "user"}` }).catch(error => {
      if (info.type !== "video") throw error
      console.warn("[media] B 站视频图卡生成失败：" + error.message)
    })
    if (!image && info.type === "video") await reply(context, formatBilibiliPreviewText(info))
    else await imageReply(context, image || undefined, "[media] B站解析完成。")
    if (signal?.aborted) return
    if (info.type === "live" && info.playerUrl) {
      await reply(context, "[media] 独立播放器：" + info.playerUrl)
    } else if (info.type === "video" && info.url && download) {
      await runDownload(context, service, target || info.url, "B站解析下载")
    }
  }

  async function runDownload(context: MessageFallbackContext, service: BilibiliService, target: string, title: string): Promise<void> {
    let result: Awaited<ReturnType<BilibiliService["download"]>> | undefined
    try {
      await recovery
      if (signal?.aborted) return
      const config = await loadGlobalConfig()
      const permissions = new PermissionService({ permissions: config.permissions })
      const subject = context.canManagePackages ? { ...context, isMaster: true } : context
      if (!permissions.explain(subject, "bilibili.download").ok) throw new Error("你没有使用 B站下载的权限。")
      const bilibili = config.bilibili as BiliConfig
      const settings = { ...bilibili, ...bilibili.download }
      const download = normalizeDownloadConfig(settings)
      if (!download.enable) throw new Error("B站下载未启用，请由 bot 主人在 global.yaml 中开启 bilibili.download.enable。")
      const installed = await Promise.all(["ffmpeg", "ffprobe"].map(name => resolveCommandPath(name, download.tools_path)))
      if (signal?.aborted) return
      // Requests with working local tools do not wait for remote version checks.
      if (context.canManagePackages && permissions.explain(subject, "tools.install").ok && installed.some(file => !file)) {
        const tools = await new ToolInstallerService({ config: config.tools }).ensureAll()
        if (!tools.ok) {
          const failures = tools.items?.filter(item => !item.ok).map(item => `${item.name}:${item.reason}`).join(" / ")
          throw new Error("工具链初始化失败：" + (failures || "unknown"))
        }
      }
      if (signal?.aborted) return
      result = await service.download(target, settings, {
        signal,
        onEvent: event => {
          console.debug("[media] B 站下载：" + event.message)
        },
      })
      if (signal?.aborted) return
      if (!result.ok) {
        if (result.reason === "live_download_unsupported") {
          return renderInfo(context, service, result.info, undefined, false)
        }
        throw new Error(mediaFailureMessage(result))
      }
      for (const file of result.files) {
        if (signal?.aborted) return
        await sendMediaFile({ ...context, reply: (...args: Parameters<MessageFallbackContext["reply"]>) => reply(context, ...args) },
          file, { ...download, file_name: result.fileNames[file] })
      }
    } catch (error) {
      await reportError(context, title, error)
    } finally {
      if (result?.ok) {
        await service.releaseTask(result).catch(error => {
          console.warn("[media] B 站任务清理失败：" + error.message)
        })
      }
    }
  }

  const fallback: MessageFallback = async (message, context) => {
    if (signal?.aborted) return
    const action = videoAction(message, context)
    if (!action) return
    const key = sessionKey(context)
    const session = currentSession(key)
    if (action.kind === "page" && !session?.tuku) return "[media] 请先发送 #点B站视频 关键词。"
    if (action.kind === "pick" && !session) {
      return action.tuku ? "[media] 搜索结果已过期，请发送 #点B站视频 关键词。" : undefined
    }
    const config = await loadGlobalConfig()
    const service = new BilibiliService({ tuneweaveConfig: config.tuneweave, searchLimit: (config.bilibili as BiliConfig).search_limit })
    switch (action.kind) {
      case "search":
        if (!action.keyword) return "[media] 请输入搜索关键词。"
        return showSearch(context, service, key, action.keyword, 1, action.tuku)
      case "page":
        if (!session) return
        if (!action.next && session.page === 1) return "[media] 当前已经是第一页。"
        return showSearch(context, service, key, session.keyword, session.page + (action.next ? 1 : -1), true)
      case "download":
        if (!action.target) return "[media] 请输入要下载的 B站链接、BV号或 av号。"
        await runDownload(context, service, action.target, "B站下载")
        return []
    }
    let target: string
    try {
      if (action.kind === "pick") {
        const item = session!.results[action.index - 1]
        if (!item) return session!.results.length ? `[media] 请输入 1-${session!.results.length} 之间的序号。` : "[media] 当前页没有可选的视频。"
        if (action.tuku) await reply(context, "正在解析中，请稍等片刻")
        target = item.url
      } else if (action.kind === "watch") {
        if (!action.keyword) return "[media] 请输入关键词。"
        const [first] = await service.search(action.keyword, { limit: 1 })
        if (!first) throw new Error("未搜索到相关视频")
        target = first.url
      } else {
        target = service.extractTarget(action.target) || ""
        if (!target) return
        const live = URL.parse(target)?.hostname === "live.bilibili.com"
        if (!live && !(await subscriptionSettings.settings("bilibili")).parseVideoLink) return
      }
      if (!signal?.aborted) await renderInfo(context, service, await service.getInfo(target), target)
    } catch (error) {
      await reportError(context, action.kind === "watch" ? "B站直看" : "B站解析", error)
    }
    return []
  }
  return {
    fallback,
    features(context: MessageFallbackContext) {
      return videoAction(context.normalizedMessage, context) ? featureNames : []
    },
    async dispose() {
      cancelRecovery?.()
      sessions.clear()
      await recovery
    },
  }
}
