import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import { randomUUID } from "node:crypto"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderTemplate, renderStatusCard } from "../../core/render/service.ts"
import { sendMediaFile, mediaFailureMessage } from "../media/files.ts"
import { buildMediaMessageText, articlePages, isMediaCommandText } from "../media/message.ts"
import { extractDouyinTarget } from "./links.ts"
import { DouyinService, normalizeDouyinDownloadConfig } from "./service.ts"

const downloadCommand = /^#抖音(?:下载|下视频)\s+([\s\S]+)$/u
const shareHost = /(?:douyin|iesdouyin)\.com/iu
const featureNames = ["[media] 抖音解析"] as const
const graphemes = new Intl.Segmenter()

// The media card fonts do not include color emoji. Keep the original in text.
function liveCardText(value: string) {
  return Array.from(graphemes.segment(value), ({ segment }) => /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(segment) ? "" : segment)
    .join("").trim()
}

type Config = Awaited<ReturnType<typeof loadGlobalConfig>>
type Reply = MessageFallbackContext["reply"]

interface Services {
  readonly signal?: AbortSignal
  readonly mediaRuntime?: { whenReady(start: () => void): () => void }
}

function sharedText(message: string, context: MessageFallbackContext): string | undefined {
  if (context.message_type === "terminal" || isMediaCommandText(message)) return
  const text = buildMediaMessageText({ ...context, msg: message })
  if (shareHost.test(text) || extractDouyinTarget(text)) return text
}

export function createDouyinCommands({ signal: lifecycle, mediaRuntime }: Services, {
  makeService = (requestTimeoutMs?: number) => new DouyinService({ timeoutMs: requestTimeoutMs }),
  loadConfig = loadGlobalConfig,
  renderLiveCard = renderStatusCard,
} = {}) {
  const stopped = new AbortController()
  const signal = lifecycle ? AbortSignal.any([lifecycle, stopped.signal]) : stopped.signal
  const work = new Set<Promise<void>>()
  let recovery: Promise<unknown> | undefined
  const cancelRecovery = mediaRuntime?.whenReady(() => {
    if (signal.aborted) return
    recovery = makeService().recoverTasks().catch(error => {
      console.warn("[media] 抖音任务恢复失败：" + error.message)
    })
  })

  async function replyImage(reply: Reply, image: Uint8Array | undefined, fallback: string) {
    if (signal.aborted) return
    if (!image || !await reply({ type: "image", file: image })) {
      if (!signal.aborted) await reply(fallback)
    }
  }

  async function handleWork(service: DouyinService, target: string, config: Config,
    context: MessageFallbackContext, showInfo: boolean) {
    const reply: Reply = (...args) => signal.aborted ? false : context.reply(...args)
    const saveId = "media-douyin-" + randomUUID()
    let result: Awaited<ReturnType<DouyinService["download"]>> | undefined
    try {
      await recovery
      if (signal.aborted) return
      const share = await service.resolveShare(target, signal)
      if (share.kind === "live") {
        const room = await service.getLiveInfo(share, signal).catch(() => undefined)
        if (signal.aborted) return
        if (!room) {
          await reply(`抖音直播间的公开资料暂时无法核实。\n${share.url}`)
          return
        }
        const items = [
          ...(room.host ? [{ label: "主播", value: room.host }] : []),
          ...(room.viewers === undefined ? [] : [{ label: "页面显示观看人数", value: String(room.viewers) }]),
        ]
        const cardItems = items.map(({ label, value }) => ({ label, value: liveCardText(value) || "见原页面" }))
        const image = await renderLiveCard({ title: liveCardText(room.title) || "抖音直播间", subtitle: "抖音直播",
          message: room.status, items: cardItems, userId: context.user_id }, { saveId }).catch(() => undefined)
        await replyImage(reply, image, [`抖音直播 · ${room.title}`, room.status, ...items.map(({ label, value }) => `${label} ${value}`)].join("\n"))
        await reply(showInfo ? share.url : `抖音直播仅提供房间预览。\n${share.url}`)
        return
      }
      const info = await service.getInfo(share.target, { signal })
      if (signal.aborted) return
      if (showInfo) {
        try {
          await replyImage(reply, await renderTemplate("douyin-info", {
            ...info, avatar: info.author?.avatar, userId: context.user_id,
          }, { saveId }), `[media] ${info.title}\n作者：${info.owner || "未知"}\n${info.url}`)
          for (const [index, page] of articlePages(info.article).entries()) {
            if (signal.aborted) return
            const image = await renderTemplate("article", {
              title: info.title, owner: info.owner, page: index + 1, blocks: page, userId: context.user_id,
            }, { saveId: `${saveId}-article-${index}` })
            await replyImage(reply, image, page.map(block => block.text || block.urls?.[0] || "").join("\n"))
          }
        } catch (error) {
          await reply(`[media] ${info.title}\n作者：${info.owner || "未知"}\n${info.url}\n信息卡生成失败：${String((error as Error).message)}`)
        }
      }
      if (signal.aborted) return
      if (!new PermissionService({ permissions: config.permissions }).explain(context, "douyin.download").ok) {
        await reply("[media] 你没有使用抖音下载的权限。")
        return
      }
      const download = normalizeDouyinDownloadConfig(config.douyin)
      if (!download.enable) {
        if (!showInfo) await reply("[media] 抖音下载未启用。")
        return
      }
      result = await service.download(info, download, {
        signal,
        onEvent: (event: { message: string }) => console.debug("[media] 抖音下载：" + event.message),
      })
      if (signal.aborted) return
      if (!result.ok || !("files" in result)) throw new Error(mediaFailureMessage("reason" in result ? result : undefined))
      if (result.warnings.length) await reply("[media] " + [...new Set(result.warnings)].join("；"))
      for (const file of result.files) {
        if (signal.aborted) return
        await sendMediaFile({ ...context, reply }, file, { ...download, signal })
      }
    } catch (error) {
      if (signal.aborted) return
      const failure = error as Error & { code?: string }
      console.warn(`[media] 抖音解析 ${failure.code || "error"}: ${failure.message}`)
      try {
        await replyImage(reply, await renderStatusCard({
          title: "抖音解析", subtitle: "Lotus-Yunzai · 抖音", badge: "失败",
          message: failure.message, userId: context.user_id,
        }, { saveId: saveId + "-error" }), "[media] " + failure.message)
      } catch {
        await reply("[media] " + failure.message)
      }
    } finally {
      if (result && "taskDir" in result) await service.releaseTask(result).catch(error => {
        console.warn("[media] 抖音任务清理失败：" + error.message)
      })
    }
  }

  const fallback: MessageFallback = async (message, context) => {
    if (signal.aborted) return
    const explicit = downloadCommand.exec(message)
    const share = explicit ? undefined : sharedText(message, context)
    if (!explicit && !share) return

    const config = await loadConfig()
    if (!config.douyin.enable) return explicit ? "[media] 抖音解析已关闭。" : undefined
    const service = makeService(config.douyin.request_timeout_ms)
    const target = explicit ? explicit[1]!.trim() : service.extractTarget(share)
    if (!target) return
    if (signal.aborted) return
    const job = handleWork(service, target, config, context, !explicit)
    work.add(job)
    try { await job } finally { work.delete(job) }
    return []
  }

  return {
    fallback,
    features(context: MessageFallbackContext) {
      return downloadCommand.test(context.normalizedMessage) || sharedText(context.normalizedMessage, context) ? featureNames : []
    },
    async dispose() {
      stopped.abort()
      cancelRecovery?.()
      await Promise.allSettled([recovery, ...work])
    },
  }
}
