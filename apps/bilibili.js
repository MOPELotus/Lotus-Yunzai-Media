import { canManagePackages } from "../../../lib/command-permissions.ts"
import { lockFile } from "../../../lib/file-lock.ts"
const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { loadGlobalConfig } from "../core/config/global.js"
import { dataPath } from "../core/path.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard, renderTemplate } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import {
  BilibiliService,
  formatBilibiliPreviewText,
  formatNumber,
  normalizeDownloadConfig,
  resolveCommandPath,
} from "../services/bilibili/service.js"
import { buildMediaMessageText } from "../services/media/message.js"
import { sendMediaFile, mediaDeliveryUnknown, mediaFailureMessage } from "../services/media/files.js"
import { ToolInstallerService } from "../services/tools/installer.js"
import { createSubscriptionConfig } from "../services/subscriptions/config.js"

const searchCache = new Map()
const legacySettings = createSubscriptionConfig(dataPath,lockFile)

export class BilibiliMedia extends BasePlugin {
  constructor() {
    super({
      name: "[media] B 站解析",
      dsc: "B 站视频与直播解析",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        { reg: "^#(荷花)?搜视频.+", fnc: "searchVideo" },
        { reg: "^#看[0-9]+$", fnc: "pickVideo" },
        { reg: "^#(荷花)?看视频.+", fnc: "directWatch" },
        { reg: "^#(B站|b站|荷花)(下载|下视频)\\s+[\\s\\S]+$", fnc: "downloadVideo" },
        { reg: "^#B站登录$", fnc: "login" },
        { reg: "^#初始化环境$", fnc: "initializeMediaTools" },
        { reg: "[\\s\\S]*", fnc: "parse" },
      ],
    })
  }

  async init() {
    await (await createService()).recoverTasks().catch(error => {
      globalThis.logger?.warn?.(`[media] B 站任务恢复失败： ${error.message}`)
    })
  }

  async parse() {
    if (this.e.message_type === "terminal") return false
    const message = buildMediaMessageText(this.e)
    if (!/(?:bilibili\.com|b23\.tv|bili2233\.cn|\bBV[1-9A-Za-z]{10}\b|\bav\d+\b)/i.test(message)) return false
    const service = await createService()
    const target = service.extractTarget(message)
    if (!target) return false
    try {
      const live = URL.parse(target)?.hostname === "live.bilibili.com"
      if (!live && !(await legacySettings.settings("bilibili")).parseVideoLink) return false
      return await this.renderInfo(await service.getInfo(target), { target, service })
    }
    catch (error) { await this.renderError("B站解析", error); return true }
  }

  async searchVideo() {
    const keyword = String(this.e.msg || "").replace(/^#(?:荷花)?搜视频/, "").trim()
    if (!keyword) {
      await replyText(this, "[media] 请输入搜索关键词。")
      return true
    }
    try {
      const results = await (await createService()).search(keyword)
      searchCache.set(cacheKey(this.e), {
        expires: Date.now() + 120000,
        results,
      })
      const image = await renderStatusCard({
        title: "B站搜索",
        subtitle: keyword,
        badge: String(results.length),
        message: results.length ? "两分钟内发送 #看1 这类序号继续解析。" : "没有搜索到相关视频。",
        userId: this.e.user_id,
        items: results.map((item, index) => ({
          label: `#看${index + 1}`,
          value: `${item.title} · ${item.author || "未知"} · ${formatNumber(item.play)}`,
        })),
      }, {
        saveId: `media-bilibili-search-${this.e.user_id || "user"}`,
      })
      await replyImage(this, image, "[media] B站搜索完成。")
    } catch (error) {
      await this.renderError("B站搜索", error)
    }
    return true
  }

  async pickVideo() {
    const cached = searchCache.get(cacheKey(this.e))
    if (!cached || cached.expires < Date.now()) return false
    const index = Number(String(this.e.msg || "").replace(/^#看/, ""))
    const item = cached.results[index - 1]
    if (!item) {
      await replyText(this, `[media] 请输入 1-${cached.results.length} 之间的序号。`)
      return true
    }
    const service = await createService()
    try { return await this.renderInfo(await service.getInfo(item.url), { target: item.url, service }) }
    catch (error) { await this.renderError("B站解析", error); return true }
  }

  async directWatch() {
    const keyword = String(this.e.msg || "").replace(/^#(?:荷花)?看视频/, "").trim()
    if (!keyword) {
      await replyText(this, "[media] 请输入关键词。")
      return true
    }
    try {
      const [first] = await (await createService()).search(keyword, { limit: 1 })
      if (!first) throw new Error("未搜索到相关视频")
      const service = await createService()
      return this.renderInfo(await service.getInfo(first.url), { target: first.url, service })
    } catch (error) {
      await this.renderError("B站直看", error)
      return true
    }
  }

  async login() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "bilibili.login")
    if (!this.e.isPrivate || !canManagePackages(this.e) || !permission.ok) {
      await this.renderError("B站登录", new Error("请由机器人主人在私聊登录 B 站账号。"))
      return true
    }

    const service = await createService()
    try {
      const qr = await service.createQrLogin()
      const image = await renderTemplate("qr-login", {
        title: "B站登录",
        subtitle: "Lotus-Yunzai · B 站",
        badge: "3 MIN",
        notice: "使用 Bilibili App 扫码确认。登录由 TuneWeave 保存，Lotus-Yunzai 仅保存账号引用。",
        qrDataUrl: qr.qrDataUrl,
        profileId: "bilibili",
      }, {
        saveId: `media-bilibili-login-${this.e.user_id || "master"}`,
      }).catch(() => undefined)
      const prefix = "data:image/png;base64,"
      const qrPng = image || (qr.qrDataUrl.startsWith(prefix) && Buffer.from(qr.qrDataUrl.slice(prefix.length), "base64"))
      if (!qrPng || !await this.reply(globalThis.segment.image(qrPng))) throw new Error("B 站登录二维码发送失败。")
      const result = await service.waitQrLogin({
        qrcodeKey: qr.qrcodeKey,
      })
      const report = await renderStatusCard({
        title: "B站登录",
        subtitle: "Lotus-Yunzai · B 站",
        badge: "完成",
        message: "B站账号引用已保存，后续搜索和解析会自动使用。",
        userId: this.e.user_id,
        items: [
          { label: "来源", value: result.account.source },
          { label: "保存时间", value: result.account.saved_at },
        ],
      }, {
        saveId: `media-bilibili-login-ok-${this.e.user_id || "master"}`,
      })
      await replyImage(this, report, "[media] B站登录完成。")
    } catch (error) {
      await this.renderError("B站登录", error)
    }
    return true
  }

  async initializeMediaTools() {
    if (!canManagePackages(this.e)) {
      await replyText(this, "[media] 只有机器人主人可以初始化媒体环境。")
      return true
    }
    const config = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: config.permissions }).explain(this.e, "tools.install")
    if (!permission.ok) {
      await replyText(this, "[media] 当前会话没有初始化工具链的权限。")
      return true
    }
    const ready = await new ToolInstallerService({ config: config.tools }).ensureAll()
    try {
      const tune = await (await createService()).tuneweave.initialize()
      ready.items.push({ name: "TuneWeave", ok: tune.ok, status: tune.version, reason: tune.message })
    } catch (error) {
      ready.items.push({ name: "TuneWeave", ok: false, reason: error.message })
    }
    const items = ready.items.map(item => ({ label: item.name, value: item.ok ? item.status || "可用" : item.reason || "检查失败" }))
    const fallback = items.map(item => `${item.label}：${item.value}`).join("\n")
    const image = await renderStatusCard({ title: "媒体环境", items }).catch(() => undefined)
    await replyImage(this, image, fallback)
    return true
  }

  async downloadVideo() {
    const target = String(this.e.msg || "").replace(/^#(?:B站|b站|荷花)(?:下载|下视频)\s*/i, "").trim()
    if (!target) {
      await replyText(this, "[media] 请输入要下载的 B站链接、BV号或 av号。")
      return true
    }

    return this.runBiliDownload(target, { service: await createService() })
  }

  async renderInfo(info, options = {}) {
    const image = await renderTemplate("bilibili-info", {
      type: info.type,
      id: info.type === "live" ? `直播间 ${info.roomId}` : info.bvid,
      title: info.title,
      owner: info.owner,
      cover: info.cover,
      duration: info.duration,
      desc: info.desc,
      liveStatus: info.liveStatus,
      online: info.online,
      stat: info.stat || {},
      userId: this.e.user_id,
    }, {
      saveId: `media-bilibili-${this.e.user_id || "user"}`,
    }).catch(error => {
      if (info.type !== "video") throw error
      globalThis.logger?.warn?.(`[media] B 站视频图卡生成失败：${error.message}`)
    })
    if (!image && info.type === "video") await replyText(this, formatBilibiliPreviewText(info))
    else await replyImage(this, image, "[media] B站解析完成。")
    if (info.type === "live" && info.playerUrl) {
      await replyText(this, `[media] 独立播放器：${info.playerUrl}`)
    } else if (info.type === "video" && info.url && options.download !== false) {
      await this.runBiliDownload(options.target || info.url, {
        service: options.service,
        title: "B站解析下载",
        announce: false,
      })
    }
    return true
  }

  async runBiliDownload(target, options = {}) {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "bilibili.download")
    if (!permission.ok) {
      await this.renderError(options.title || "B站下载", new Error("你没有使用 B站下载的权限。"))
      return true
    }

    const downloadConfig = normalizeDownloadConfig({
      ...(globalConfig.bilibili || {}),
      ...(globalConfig.bilibili?.download || {}),
    })
    if (!downloadConfig.enable) {
      await this.renderError(options.title || "B站下载", new Error("B站下载未启用，请由 bot 主人在 global.yaml 中开启 bilibili.download.enable。"))
      return true
    }

    const service = options.service || await createService()
    let result
    try {
      const installPermission = new PermissionService({ permissions: globalConfig.permissions })
        .explain(this.e, "tools.install")
      const existingTools = await Promise.all(["ffmpeg", "ffprobe"].map(name => resolveCommandPath(name, downloadConfig.tools_path)))
      // A video request must not wait for GitHub update checks when the
      // installed tools are present. Startup maintenance checks their integrity.
      if (installPermission.ok && canManagePackages(this.e) && existingTools.some(file => !file)) {
        const tools = await new ToolInstallerService({ config: globalConfig.tools }).ensureAll()
        if (!tools.ok) {
          throw new Error(`工具链初始化失败：${tools.items?.filter(item => !item.ok).map(item => `${item.name}:${item.reason}`).join(" / ") || "unknown"}`)
        }
      }
      result = await service.download(target, {
        ...(globalConfig.bilibili || {}),
        ...(globalConfig.bilibili?.download || {}),
      }, {
        onEvent: async event => {
          if (event.message) globalThis.logger?.debug?.(`[media] B 站下载： ${event.message}`)
        },
      })
      if (!result.ok) {
        if (result.reason === "live_download_unsupported" && result.info) {
          return this.renderInfo(result.info, { download: false })
        }
        await this.renderError(options.title || "B站下载", new Error(mediaFailureMessage(result)))
        return true
      }

      for (const file of result.files || []) {
        await sendMediaFile(this.e, file, { ...downloadConfig, file_name: result.fileNames?.[file] })
      }
    } catch (error) {
      await this.renderError(options.title || "B站下载", error)
    } finally {
      if (result?.taskDir) {
        await service.releaseTask(result).catch(error => {
          globalThis.logger?.warn?.(`[media] B 站任务清理失败： ${error.message}`)
        })
      }
    }
    return true
  }

  async renderError(title, error) {
    const diskFull = error.code === "ENOSPC" || error.code === "EDQUOT" || /No space left on device|Disk quota exceeded/i.test(error.message)
    const image = await renderStatusCard({
      title,
      subtitle: "Lotus-Yunzai · B 站",
      badge: "失败",
      message: diskFull ? "服务器磁盘空间不足，暂时无法下载或合并视频。" : error.message,
      userId: this.e.user_id,
      items: error.code === mediaDeliveryUnknown ? [] : [
        { label: "建议", value: diskFull ? "请联系机器人主人清理磁盘空间后重试。" : "检查链接是否有效，或稍后重试。" },
      ],
    }, {
      saveId: `media-bilibili-error-${this.e.user_id || "user"}`,
    })
    await replyImage(this, image, `[media] ${title}失败。`)
  }
}

async function createService() {
  const config = await loadGlobalConfig()
  const service = new BilibiliService({
    tuneweaveConfig: config.tuneweave,
    searchLimit: config.bilibili?.search_limit,
  })
  return service
}

function cacheKey(e) {
  return `${e.self_id || ""}:${e.group_id || "private"}:${e.user_id}`
}

export const buildBilibiliMessageText = buildMediaMessageText
