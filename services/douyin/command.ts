import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import { randomUUID } from "node:crypto"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderTemplate, renderStatusCard } from "../../core/render/service.ts"
import { sendMediaFile, mediaFailureMessage, mediaDeliveryUnknown } from "../media/files.ts"
import { buildMediaMessageText, articlePages, isMediaCommandText } from "../media/message.ts"
import { extractDouyinTarget } from "./links.ts"
import { DouyinService, normalizeDouyinDownloadConfig } from "./service.ts"

const downloadCommand = /^#抖音(?:下载|下视频)(?:\s+([\s\S]*))?$/u
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

function sharedTarget(message: string, context: MessageFallbackContext) {
  if (context.message_type === "terminal" || isMediaCommandText(message)) return
  return extractDouyinTarget(buildMediaMessageText({ ...context, msg: message }))
}

export function createDouyinCommands({ signal: lifecycle, mediaRuntime }: Services, {
  makeService = (requestTimeoutMs?: number) => new DouyinService({ timeoutMs: requestTimeoutMs }),
  loadConfig = loadGlobalConfig,
  renderLiveCard = renderStatusCard,
  render = renderTemplate,
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

  async function replyImage(reply: Reply, active: AbortSignal, maxBytes: number,
    draw: (renderScale?: number) => Promise<Uint8Array | undefined>, fallback: string) {
    let image = await draw().catch(() => undefined)
    if (image && image.byteLength > maxBytes && Number(Bun.env.LOTUS_RENDER_SCALE ?? 4) > 2 && !active.aborted) {
      image = await draw(2).catch(() => undefined)
    }
    if (active.aborted) return
    if (!image || image.byteLength > maxBytes || !await reply({ type: "image", file: image })) {
      if (!active.aborted) await reply(fallback)
    }
  }

  async function handleWork(service: DouyinService, target: string, config: Config,
    context: MessageFallbackContext, showInfo: boolean, active: AbortSignal) {
    const reply: Reply = (...args) => active.aborted ? false : context.reply(...args)
    const maxBytes = context.inlineImageByteLimit ?? 16 * 1024 * 1024
    const saveId = "media-douyin-" + randomUUID()
    let result: Awaited<ReturnType<DouyinService["download"]>> | undefined
    try {
      await recovery
      if (active.aborted) return
      const share = await service.resolveShare(target, active)
      if (share.kind === "live") {
        const room = await service.getLiveInfo(share, active).catch(() => undefined)
        if (active.aborted) return
        if (!room) {
          await reply(`抖音直播间的公开资料暂时无法核实。\n${share.url}`)
          return
        }
        const items = [
          { label: "房间标题", value: room.title },
          ...(room.host ? [{ label: "主播", value: room.host }] : []),
          ...(room.viewers === undefined ? [] : [{ label: "页面显示观看人数", value: String(room.viewers) }]),
        ]
        const cardItems = items.map(({ label, value }) => ({ label, value: liveCardText(value) || "见原页面" }))
        await replyImage(reply, active, maxBytes, renderScale => renderLiveCard({
          title: room.status, subtitle: "抖音", items: cardItems, userId: context.user_id,
        }, { saveId, renderScale }), [`抖音 · ${room.status}`,
          ...items.map(({ label, value }) => `${label} ${value}`)].join("\n"))
        await reply(showInfo ? share.url : `抖音直播仅提供房间预览。\n${share.url}`)
        return
      }
      const allowed = new PermissionService({ permissions: config.permissions }).explain(context, "douyin.download").ok
      const download = normalizeDouyinDownloadConfig(config.douyin)
      const denied = "[media] 你没有使用抖音下载的权限。"
      if (!showInfo && (!allowed || !download.enable)) {
        await reply(allowed ? "[media] 抖音下载未启用。" : denied)
        return
      }
      const info = await service.getInfo(share.target, { signal: active })
      if (active.aborted) return
      if (showInfo) {
        await replyImage(reply, active, maxBytes, renderScale => render("douyin-info", {
          ...info, avatar: info.author?.avatar, userId: context.user_id,
        }, { saveId, renderScale }), `[media] ${info.title}\n作者：${info.owner || "未知"}\n${info.url}`)
        for (const [index, page] of articlePages(info.article).entries()) {
          if (active.aborted) return
          await replyImage(reply, active, maxBytes, renderScale => render("article", {
            title: info.title, owner: info.owner, page: index + 1, blocks: page, userId: context.user_id,
          }, { saveId: `${saveId}-article-${index}`, renderScale }), page.map(block => block.text || block.urls?.[0] || "").join("\n"))
        }
      }
      if (active.aborted) return
      if (!allowed) {
        await reply(denied)
        return
      }
      if (!download.enable) return
      result = await service.download(info, download, {
        signal: active,
        onEvent: (event: { message: string }) => console.debug("[media] 抖音下载：" + event.message),
      })
      if (active.aborted) return
      if (!result.ok || !("files" in result)) throw new Error(mediaFailureMessage("reason" in result ? result : undefined))
      if (result.warnings.length) await reply("[media] " + [...new Set(result.warnings)].join("；"))
      for (const file of result.files) {
        if (active.aborted) return
        await sendMediaFile({ ...context, reply }, file, { ...download, signal: active })
      }
    } catch (error) {
      if (active.aborted) return
      const code = error instanceof Error && "code" in error ? error.code : undefined
      const message = error instanceof Error ? error.message : "抖音解析失败，请稍后重试。"
      console.warn(`[media] 抖音解析 ${code || "error"}: ${message}`)
      await replyImage(reply, active, maxBytes, renderScale => renderStatusCard({
        title: "抖音解析", subtitle: "Lotus-Yunzai · 抖音", badge: code === mediaDeliveryUnknown ? "未确认" : "失败",
        message, userId: context.user_id,
      }, { saveId: saveId + "-error", renderScale }), "[media] " + message)
    } finally {
      if (result && "taskDir" in result) await service.releaseTask(result).catch(error => {
        console.warn("[media] 抖音任务清理失败：" + error.message)
      })
    }
  }

  const fallback: MessageFallback = async (message, context) => {
    if (signal.aborted) return
    const explicit = downloadCommand.exec(message)
    const target = explicit ? explicit[1]?.trim() ?? "" : sharedTarget(message, context)
    if (!explicit && !target) return
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
    const active = connection ? AbortSignal.any([signal, connection]) : signal
    if (active.aborted) return

    const config = await loadConfig()
    if (active.aborted) return
    if (!config.douyin.enable) return explicit ? "[media] 抖音解析已关闭。" : undefined
    if (!target) return "[media] 请输入要下载的抖音分享链接。"
    const service = makeService(config.douyin.request_timeout_ms)
    const job = handleWork(service, target, config, context, !explicit, active)
    work.add(job)
    try { await job } finally { work.delete(job) }
    return []
  }

  return {
    fallback,
    features(context: MessageFallbackContext) {
      return downloadCommand.test(context.normalizedMessage) || sharedTarget(context.normalizedMessage, context) ? featureNames : []
    },
    async dispose() {
      stopped.abort()
      cancelRecovery?.()
      await Promise.allSettled([recovery, ...work])
    },
  }
}
