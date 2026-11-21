import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderStatusCard, renderTemplate } from "../../core/render/service.ts"
import { formatLocalDateTime } from "../../core/time.ts"
import { safeMediaName } from "../media/files.ts"
import { TuneWeaveService } from "../tuneweave/service.ts"
import { readPartnerLog, partnerLogNodes } from "./partner-log.ts"
import { NeteasePartnerTask, type PartnerConfig, type PartnerReport } from "./partner-task.ts"
import { MusicService, MUSIC_PLATFORMS, MUSIC_QR_TYPES, musicLoginTimeout, musicSessionKey, musicShare, type MusicTrack, type MusicConfig } from "./service.ts"

const aliases: Readonly<Record<string, string>> = {
  网易云: "netease", 网易: "netease", QQ: "qq", qq: "qq", QQ音乐: "qq",
  酷狗: "kugou", 酷我: "kuwo", 咪咕: "migu", 汽水: "soda",
}
const featureNames = ["[media] 点歌"] as const
const maxInlineBytes = 16 * 1024 * 1024
const searchCommand = /^#(网易云|网易|QQ音乐|QQ|qq|酷狗|酷我|咪咕|汽水)?(?:点歌|搜歌)\s*([\s\S]*)$/u
const choiceCommand = /^(?:[0-9]+|#听[0-9]+|#(?:音乐)?下一页|#(?:取消|音乐取消))$/u
const partnerManualCommand = /^#合伙人测试(?:[（(]执行[）)])?$/u
const help = "点歌：#网易点歌 歌名 / #QQ点歌 歌名 / #酷狗点歌 歌名\n也支持酷我、咪咕、汽水；#点歌 默认网易云。搜索后输入数字选歌，#下一页 翻页，#取消 结束。默认发送音乐卡片和完整语音，播放自动回退音源。建议主人 #音乐登录 扫码；网易云与 #合伙人登录 共用账号。"
const searchNotes: Readonly<Record<string, string>> = {
  selected: "本次搜索已选用公共音乐账号。",
  unverified: "公共音乐账号的登录状态待确认。",
  unconfigured: "当前平台未配置公共音乐账号。主人可用 #音乐登录 查看支持扫码的平台。",
}

type Global = Awaited<ReturnType<typeof loadGlobalConfig>>
type Context = MessageFallbackContext
type Prepared = Awaited<ReturnType<MusicService["prepare"]>>
type Menu = { readonly name: string; readonly platform: string }
type ScanType = { readonly name: string; readonly type: string }
type SessionBase = { readonly api: MusicService; expires: number }
type SearchSession = SessionBase & { readonly stage: "search"; readonly platform: string; readonly keyword: string;
  readonly timeoutMs: number; page: number; tracks?: readonly MusicTrack[]; loading?: boolean }
type Scan = { readonly api: MusicService; readonly platform: string; readonly partner?: true; readonly timeoutMs?: number; readonly pollMs?: number }
type ScanSession = SessionBase & Scan & { readonly stage: "polling"; readonly controller: AbortController }
type Session = SearchSession | ScanSession |
  (SessionBase & { readonly stage: "platform"; readonly platforms: readonly Menu[] }) |
  (SessionBase & { readonly stage: "type"; readonly platform: string; readonly types: readonly ScanType[] })
type PartnerJob = { readonly controller: AbortController;
  promise?: ReturnType<NeteasePartnerTask["execute"]> }
interface Services {
  readonly signal?: AbortSignal
  readonly mediaRuntime?: { whenReady(start: () => void): () => void }
}

const musicNames: Readonly<Record<string, string>> = MUSIC_PLATFORMS
const scanTypes: Readonly<Record<string, readonly ScanType[]>> = MUSIC_QR_TYPES
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请稍后重试。"
const loginTime = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : fallback

function ownerPermission(context: Context, config: Global) {
  if (context.canManagePackages !== true || context.isDelegated) return false
  const { scopes, ...permissions } = config.permissions
  return new PermissionService({ permissions: { ...permissions, scopes: {
    "netease.partner": { policy: "master_only" }, ...scopes,
  } } }).can({ ...context, isMaster: true }, "netease.partner")
}

function credentialScope(context: Context): AbortSignal | undefined {
  return context.message_type === "private" && context.canManagePackages && !context.isDelegated
    ? context.privateCredentialSignal : undefined
}

function apiOrigin(address: unknown) {
  const url = typeof address === "string" && URL.parse(address)
  return url && ["http:", "https:"].includes(url.protocol) ? url.origin : "地址未配置"
}

async function openMusic() {
  const config = await loadGlobalConfig()
  const music = config.music as Partial<MusicConfig>
  const tools = config.tools as { bin_dir?: string }
  if (music.enable === false) throw new Error("点歌功能已关闭")
  return { api: new MusicService({ tuneweaveConfig: config.tuneweave, config: music, toolsPath: tools.bin_dir }),
    defaultPlatform: music.default_platform || "netease", timeoutMs: music.session_timeout_ms || 120000 }
}

async function renderPartnerReport(title: string, report: PartnerReport, userId?: number) {
  const items = report.accounts.map(account => ({
    label: account.nickname,
    value: `成功 ${account.success} · 失败 ${account.fail}`,
  }))
  const image = await renderStatusCard({ title, subtitle: report.trigger, badge: report.accounts.some(account => account.fail) ? "有失败" : "完成",
    message: `生成时间：${report.time}`, userId, items,
  }).catch(() => undefined)
  return { image, text: [title, ...items.map(item => `${item.label}：${item.value}`)].join("\n") }
}

export function createMusicCommands({ signal, mediaRuntime }: Services) {
  const sessions = new Map<string, Session>()
  const activeLogins = new Map<string, ScanSession>()
  const stopped = new AbortController()
  const moduleSignal = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal
  let partnerJob: PartnerJob | undefined
  let recovery: Promise<unknown> | undefined

  function drop(key: string, session: Session) {
    if (session.stage === "polling") session.controller.abort()
    if (sessions.get(key) === session) sessions.delete(key)
  }

  function replace(key: string, session: Session) {
    const previous = sessions.get(key)
    if (previous) drop(key, previous)
    sessions.set(key, session)
  }

  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, session] of sessions) if (session.expires <= now) drop(key, session)
  }, 30_000).unref()
  const cancelRecovery = mediaRuntime?.whenReady(() => {
    if (moduleSignal.aborted) return
    recovery = (async () => {
      const { api } = await openMusic()
      if (!moduleSignal.aborted) await Promise.all([api.adoptPartnerAccount(), api.recoverTasks()])
    })().catch(error => {
      if (!moduleSignal.aborted) console.debug("[media] 音乐目录初始化：" + errorText(error))
    })
  })

  async function runPartnerTask(config: Global, trigger: string, {
    signal: request, once, before,
  }: { signal?: AbortSignal; once?: boolean; before?: () => unknown } = {}) {
    if (partnerJob || activeLogins.has("netease")) return { skipped: true as const, reason: "busy" }
    const job: PartnerJob = { controller: new AbortController() }
    partnerJob = job
    const active = AbortSignal.any([moduleSignal, job.controller.signal, ...(request ? [request] : [])])
    try {
      active.throwIfAborted()
      await before?.()
      active.throwIfAborted()
      const task = new NeteasePartnerTask({ tuneweaveConfig: config.tuneweave })
      job.promise = task.execute(config.netease_partner as PartnerConfig, trigger, { signal: active, once })
      return await job.promise
    } finally {
      if (partnerJob === job) partnerJob = undefined
    }
  }

  function reply(context: Context, ...args: Parameters<Context["reply"]>) {
    return moduleSignal.aborted ? false : context.reply(...args)
  }

  async function imageReply(context: Context, image: Uint8Array | undefined, fallback: string) {
    if (!image || !await reply(context, { type: "image", file: image })) await reply(context, fallback)
  }

  async function sendVoice(context: Context, media: Prepared) {
    moduleSignal.throwIfAborted()
    const name = safeMediaName(media.track.name) + ".wav"
    if (context.deliverMedia) {
      const result = await context.deliverMedia({ path: media.voiceFile, name, type: "record" })
      if (result === "confirmed") return
      if (result === "unknown") throw new Error("语音送达未确认，请在会话中核对。")
    }
    moduleSignal.throwIfAborted()
    const file = Bun.file(media.voiceFile)
    if (file.size > maxInlineBytes) {
      const result = await context.deliverMedia?.({ path: media.voiceFile, name, type: "file" })
      if (result === "confirmed") return
      if (result === "unknown") throw new Error("音乐文件送达未确认，请在会话中核对。")
      throw new Error("完整音频超过当前会话的发送上限。")
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (await reply(context, { type: "record", file: bytes })) return
    moduleSignal.throwIfAborted()
    const result = await context.uploadFile?.({ name, bytes })
    if (result === "confirmed") return
    if (result === "unknown") throw new Error("音乐文件送达未确认，请在会话中核对。")
    throw new Error("语音发送失败。")
  }

  async function sendTrackInfo(context: Context, track: MusicTrack, media: Prepared) {
    moduleSignal.throwIfAborted()
    const share = musicShare(track, media.stream)
    if (share && context.sendMusicCard) {
      const result = await context.sendMusicCard(share.data)
      if (result === "confirmed") return
      if (result === "unknown") {
        await reply(context, "音乐卡片送达未确认，继续发送完整音频。")
        return
      }
    }
    const artists = track.artists?.map(artist => artist.name).join(" / ") || "未知歌手"
    const fallback = `《${track.name}》 · ${artists}`
    const image = await renderStatusCard({ title: track.name, subtitle: artists,
      message: `完整音频 · ${Math.round(media.duration)} 秒`,
      items: [{ label: "实际音源", value: musicNames[media.stream.resolved_platform ?? ""] || media.stream.resolved_platform || musicNames[track.platform] }],
    }).catch(() => undefined)
    await imageReply(context, image, fallback)
  }

  async function showResults(context: Context, key: string, session: SearchSession) {
    session.loading = true
    try {
      const search = await session.api.search(session.platform, session.keyword, session.page)
      if (sessions.get(key) !== session || moduleSignal.aborted) return
      const tracks: readonly MusicTrack[] = search.tracks
      session.tracks = tracks
      session.expires = Date.now() + session.timeoutMs
      const message = tracks.length ?
        "两分钟内回复数字选歌。#下一页 翻页，#取消 结束。播放时自动尝试完整备用音源。" + searchNotes[search.accountStatus] :
        "没有搜索结果，可更换关键词或平台。"
      const image = await renderStatusCard({ title: musicNames[session.platform] + "点歌", subtitle: session.keyword,
        badge: `第 ${session.page} 页`, userId: context.user_id, message,
        items: tracks.map((track, index) => ({ label: String(index + 1),
          value: `${track.name} · ${track.artists?.map(artist => artist.name).join(" / ") || "未知歌手"}` })),
      }, { saveId: `media-music-search-${context.user_id}` }).catch(() => undefined)
      if (sessions.get(key) === session) await imageReply(context, image, [message,
        ...tracks.map((track, index) => `${index + 1}. ${track.name}`)].join("\n"))
    } finally {
      session.loading = false
    }
  }

  async function scan(context: Context, key: string, scanOptions: Scan, type?: string) {
    const friend = credentialScope(context)
    if (!friend) throw new Error("请由机器人主人在私聊维护公共音乐账号。")
    const { platform, api } = scanOptions
    if (platform === "netease" && partnerJob) throw new Error("网易云合伙人任务正在进行，请稍候。")
    if (activeLogins.has(platform)) throw new Error("这个平台已有扫码操作，请等它结束。")
    const timeoutMs = scanOptions.timeoutMs ?? musicLoginTimeout(platform)
    const controller = new AbortController()
    const session: ScanSession = { ...scanOptions, stage: "polling", controller, expires: Date.now() + timeoutMs }
    replace(key, session)
    activeLogins.set(platform, session)
    const active = AbortSignal.any([friend, moduleSignal, controller.signal])
    try {
      active.throwIfAborted()
      if (session.partner) await api.tuneweave.requireReady("netease", active)
      const login = await api.createLogin(platform, context.user_id, type, { signal: active })
      active.throwIfAborted()
      const image = await renderTemplate("qr-login", { title: musicNames[platform] + "登录",
        subtitle: session.partner ? "音乐合伙人" : "公共音乐账号", badge: "SCAN",
        notice: "建议使用对应平台 App 扫码确认。账号供机器人点歌使用，#取消 可结束等待。",
        qrDataUrl: login.image, profileId: platform,
      }).catch(() => undefined)
      active.throwIfAborted()
      if (!image) throw new Error("音乐登录二维码暂时无法生成，请稍后重试。")
      let delivered = false
      await reply(context, { type: "image", file: image }, false, { onDelivered: () => { delivered = true } })
      if (!delivered) throw new Error("音乐登录二维码送达未确认，请重试。")
      active.throwIfAborted()
      session.expires = Date.now() + timeoutMs
      await api.waitLogin(login, { signal: active, timeoutMs, pollMs: session.pollMs })
      if (active.aborted) return
      if (session.partner) {
        const done = "网易云合伙人账号已登录。"
        const image = await renderStatusCard({ title: "合伙人登录", subtitle: "音乐合伙人", message: done }).catch(() => undefined)
        if (!active.aborted) await imageReply(context, image, done)
      } else await reply(context, musicNames[platform] + "公共音乐账号已登录。")
    } catch (error) {
      if (!active.aborted) throw error
    } finally {
      if (activeLogins.get(platform) === session) activeLogins.delete(platform)
      if (sessions.get(key) === session) sessions.delete(key)
    }
  }

  async function choose(message: string, context: Context, key: string) {
    const session = sessions.get(key)
    if (!session) return
    if (session.expires <= Date.now()) { drop(key, session); return }
    if (/^#(?:音乐)?取消$/u.test(message)) {
      drop(key, session)
      return "已取消本次音乐操作。"
    }
    try {
      if (session.stage === "search") {
        if (session.loading) return "正在搜索，请稍候。"
        if (/^#(?:音乐)?下一页$/u.test(message)) {
          session.page++
          try { await showResults(context, key, session) }
          catch (error) { session.page--; throw error }
          return []
        }
        const track = session.tracks?.[Number(message.replace(/^#听/u, "")) - 1]
        if (!track) return `请输入 1–${session.tracks?.length || 0} 的序号。`
        sessions.delete(key)
        await reply(context, `正在获取《${track.name}》完整音源…`)
        let media
        try {
          media = await session.api.prepare(track, { signal: moduleSignal })
          await sendTrackInfo(context, track, media)
          await sendVoice(context, media)
        } finally {
          if (media) await session.api.cleanup(media)
        }
      } else {
        if (!credentialScope(context)) throw new Error("请由机器人主人在私聊维护公共音乐账号。")
        const index = Number(message) - 1
        if (session.stage === "platform") {
          const selected = session.platforms[index]
          if (!selected) throw new Error("请选择列表中的平台序号")
          const types = scanTypes[selected.platform]
          if (types) {
            sessions.set(key, { stage: "type", api: session.api, expires: session.expires, platform: selected.platform, types })
            return "请选择扫码方式：\n" + types.map((item, index) => `${index + 1}. ${item.name}`).join("\n")
          }
          await scan(context, key, { api: session.api, platform: selected.platform })
        } else if (session.stage === "type") {
          const type = session.types[index]
          if (!type) throw new Error("请选择列表中的扫码方式序号")
          await scan(context, key, session, type.type)
        }
      }
    } catch (error) {
      if (!moduleSignal.aborted) return "[media] 音乐：" + errorText(error)
    }
    return []
  }

  function action(message: string) {
    if (searchCommand.test(message)) return "search"
    if (choiceCommand.test(message)) return "choice"
    if (partnerManualCommand.test(message)) return "partnerManual"
    switch (message) {
      case "#音乐登录": return "login"
      case "#音乐帮助": return "help"
      case "#合伙人登录": return "partnerLogin"
      case "#合伙人日志": return "partnerLog"
      case "#初始化TuneWeave": return "initialize"
      case "#TuneWeave状态": return "status"
    }
  }

  const fallback: MessageFallback = async (message, context) => {
    if (moduleSignal.aborted) return
    const selected = action(message)
    if (!selected) return
    const key = musicSessionKey(context)
    if (selected === "choice") return choose(message, context, key)
    if (selected === "help") return help
    if (selected === "search") {
      try {
        const { api, defaultPlatform, timeoutMs } = await openMusic()
        await recovery
        const match = searchCommand.exec(message)!
        const keyword = match[2]!.trim()
        if (!keyword) return help
        const platform = aliases[match[1] || ""] || defaultPlatform
        const session: SearchSession = { stage: "search", api, platform, timeoutMs, keyword, page: 1, expires: Date.now() + timeoutMs }
        replace(key, session)
        try { await showResults(context, key, session) }
        catch (error) {
          if (sessions.get(key) !== session) return []
          drop(key, session)
          throw error
        }
      } catch (error) { return "[media] 点歌：" + errorText(error) }
      return []
    }
    if (selected === "login") {
      if (!credentialScope(context)) return "请由机器人主人在私聊维护公共音乐账号。"
      try {
        const { api, timeoutMs } = await openMusic()
        const platforms = (await api.platforms()).filter(item => item.capabilities.includes("qr_login"))
        if (!platforms.length) throw new Error("当前 TuneWeave 没有可扫码的平台。")
        replace(key, { stage: "platform", api, platforms, expires: Date.now() + timeoutMs })
        return "请选择扫码平台：\n" + platforms.map((item, index) => `${index + 1}. ${item.name}`).join("\n") +
          "\n输入数字继续，#取消 退出。网易云与合伙人登录共用。"
      } catch (error) { return "[media] 音乐：" + errorText(error) }
    }

    const config = await loadGlobalConfig()
    const owner = ownerPermission(context, config)
    if (selected === "partnerLogin") {
      if (!credentialScope(context) || !owner) return "请由机器人主人在私聊登录音乐合伙人账号。"
      const old = sessions.get(key)
      if (old) drop(key, old)
      const api = new MusicService({ tuneweaveConfig: config.tuneweave })
      const partner = config.netease_partner as PartnerConfig
      try {
        await scan(context, key, { api, platform: "netease", partner: true,
          timeoutMs: loginTime(partner.login_timeout_ms, musicLoginTimeout("netease")),
          pollMs: loginTime(partner.login_poll_ms, 3000) })
      } catch (error) { return "[media] 音乐：合伙人登录失败：" + errorText(error) }
      return []
    }
    if (selected === "partnerLog") {
      if (!credentialScope(context) || !owner) return "请由机器人主人在私聊查看合伙人日志。"
      let report
      try { report = await readPartnerLog() }
      catch { return "[media] 无法读取合伙人日志。" }
      if (report) return { type: "forward", nodes: partnerLogNodes(report) }
      const image = await renderStatusCard({ title: "合伙人日志", subtitle: "最近日志", badge: "空",
        message: `生成时间：${formatLocalDateTime()}`, items: [{ label: "暂无日志", value: "成功 0 · 失败 0" }],
      }).catch(() => undefined)
      await imageReply(context, image, "合伙人日志 · 暂无日志")
      return []
    }
    if (selected === "partnerManual") {
      if (!owner) return "仅机器人主人可执行合伙人任务。"
      const request = context.privateCredentialSignal
      try {
        const report = await runPartnerTask(config, "手动执行", {
          signal: request, before: () => reply(context, "网易云合伙人任务开始，将按账号配置提交评分和乐评。"),
        })
        if (request?.aborted || moduleSignal.aborted) return []
        if ("skipped" in report) return "合伙人任务或网易云登录正在进行，请稍候。"
        const card = await renderPartnerReport("合伙人测试", report, context.user_id)
        if (!request?.aborted) await imageReply(context, card.image, card.text)
      } catch {
        if (!request?.aborted && !moduleSignal.aborted) return "合伙人任务未完成，请检查 TuneWeave 状态和最近日志。"
      }
      return []
    }
    if (selected === "initialize") {
      if (!owner) return "只有机器人主人可以初始化 TuneWeave。"
      try {
        const result = await new TuneWeaveService({ config: config.tuneweave }).initialize({
          platform: "netease", onProgress: async (text: string) => { await reply(context, "[media] " + text) },
        })
        return "[media] TuneWeave 初始化完成 · " + result.version + " · " + apiOrigin(result.apiUrl)
      } catch (error) { return "[media] TuneWeave 初始化失败：" + errorText(error) }
    }
    if (!owner) return "只有机器人主人可以查看 TuneWeave 状态。"
    const status = await new TuneWeaveService({ config: config.tuneweave }).status("netease", moduleSignal)
    return "[media] TuneWeave " + (status.requiresUpdate ? "待更新" : status.ok ? "就绪" : "未就绪") +
      " · " + (status.version || "未知版本") + "\n" + apiOrigin(status.apiUrl) + "\n" + status.message
  }

  return {
    fallback,
    features(context: Context) {
      const selected = action(context.normalizedMessage)
      return selected && (selected !== "choice" || sessions.has(musicSessionKey(context))) ? featureNames : []
    },
    executePartner: runPartnerTask,
    renderPartner: renderPartnerReport,
    async dispose() {
      stopped.abort()
      cancelRecovery?.()
      clearInterval(timer)
      for (const [key, session] of sessions) drop(key, session)
      activeLogins.clear()
      const job = partnerJob
      job?.controller.abort()
      await Promise.allSettled([recovery, job?.promise])
    },
  }
}
