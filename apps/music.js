const BasePlugin = globalThis.plugin
import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { canManagePackages } from "../../../lib/command-permissions.ts"
import { makeForwardMsg } from "../../../lib/common/common.js"
import { PermissionService } from "../core/permissions/service.js"
import { TuneWeaveService } from "../services/tuneweave/service.js"
import { safeMediaName } from "../services/media/files.js"
import { renderStatusCard, renderTemplate } from "../core/render/service.js"
import { formatLocalDateTime } from "../core/time.js"
import { loadGlobalConfig } from "../core/config/global.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { MusicService, MUSIC_PLATFORMS, MUSIC_QR_TYPES, musicSessionKey, musicShare } from "../services/music/service.js"
import { readPartnerLog, partnerLogNodes } from "../services/music/partner-log.js"

const sessions = new Map(), aliases = { 网易云: "netease", 网易: "netease", QQ: "qq", qq: "qq", QQ音乐: "qq", 酷狗: "kugou", 酷我: "kuwo", 咪咕: "migu", 汽水: "soda" }
const activeLogins = new Map()
const maxInlineBytes = 16 * 1024 * 1024
const canManageMusic = e => e.isPrivate && canManagePackages(e)
const searchAccountNotes = {
  selected: "本次搜索已选用公共音乐账号。",
  unverified: "公共音乐账号的登录状态待确认。",
  unconfigured: "当前平台未配置公共音乐账号。主人可用 #音乐登录 查看支持扫码的平台。",
}

function ownerPermission(event, config) {
  if (!canManagePackages(event)) return false
  const { scopes, ...permissions } = config.permissions || {}
  return new PermissionService({
    permissions: { ...permissions, scopes: { "netease.partner": { policy: "master_only" }, ...scopes } },
  }).can(event, "netease.partner")
}

function apiOrigin(address) {
  const url = typeof address === "string" && URL.parse(address)
  return url && ["http:", "https:"].includes(url.protocol) ? url.origin : "地址未配置"
}

function loginTime(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : fallback
}

async function sendVoice(e, media) {
  const name = `${safeMediaName(media.track.name)}.wav`
  if (e.deliverMedia) {
    const result = await e.deliverMedia({ path: media.voiceFile, name, type: "record" })
    if (result === "confirmed") return
    if (result === "unknown") throw new Error("语音送达未确认，请在会话中核对。")
  }
  const file = Bun.file(media.voiceFile)
  if (file.size > maxInlineBytes) {
    if (e.deliverMedia) {
      const result = await e.deliverMedia({ path: media.voiceFile, name, type: "file" })
      if (result === "confirmed") return
      if (result === "unknown") throw new Error("音乐文件送达未确认，请在会话中核对。")
    }
    throw new Error("完整音频超过当前会话的发送上限。")
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (await e.reply(globalThis.segment.record(bytes))) return
  const result = await e.uploadFile?.({ name, bytes })
  if (result === "confirmed") return
  if (result === "unknown") throw new Error("音乐文件送达未确认，请在会话中核对。")
  throw new Error("语音发送失败。")
}

async function sendTrackInfo(e, track, media) {
  const share = musicShare(track, media.stream)
  if (share && e.sendMusicCard) {
    const result = await e.sendMusicCard(share.data)
    if (result === "confirmed") return
    if (result === "unknown") {
      await replyText(e, "音乐卡片送达未确认，继续发送完整音频。")
      return
    }
  }
  const artists = track.artists?.map(artist => artist.name).join(" / ") || "未知歌手"
  const fallback = `《${track.name}》 · ${artists}`
  const image = await renderStatusCard({
    title: track.name,
    subtitle: artists,
    message: `完整音频 · ${Math.round(media.duration)} 秒`,
    items: [{ label: "实际音源", value: MUSIC_PLATFORMS[media.stream.resolved_platform] || media.stream.resolved_platform || MUSIC_PLATFORMS[track.platform] }],
  }).catch(() => undefined)
  await replyImage(e, image, fallback)
}
async function service() {
  const config = await loadGlobalConfig()
  if (config.music?.enable === false) throw new Error("点歌功能已关闭")
  return { service: new MusicService({ tuneweaveConfig: config.tuneweave, config: config.music, toolsPath: config.tools?.bin_dir }), config: config.music || {} }
}
export class MusicMedia extends BasePlugin {
  constructor() {
    super({ name: "[media] 点歌", dsc: "按平台点歌与公共账号登录", event: "message", priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        { reg: "^#(?:荷花)?(?:(?:网易云|网易|QQ音乐|QQ|qq|酷狗|酷我|咪咕|汽水))?(?:点歌|搜歌)[\\s\\S]*$", fnc: "search" },
        { reg: "^#(?:荷花)?音乐登录$", fnc: "login" },
        { reg: "^(?:[0-9]+|#听[0-9]+|#(?:音乐)?下一页|#(?:取消|音乐取消))$", fnc: "choice" },
        { reg: "^#音乐帮助$", fnc: "help" },
        { reg: "^#合伙人登录$", fnc: "partnerLogin" },
        { reg: "^#合伙人日志$", fnc: "partnerLog" },
        { reg: "^#初始化TuneWeave$", fnc: "initializeTuneWeave" },
        { reg: "^#TuneWeave状态$", fnc: "tuneWeaveStatus" },
      ] })
  }
  async init() {
    const timer = setInterval(() => {
      for (const [key, session] of sessions) {
        if (session.expires <= Date.now()) {
          session.controller?.abort()
          sessions.delete(key)
        }
      }
    }, 30000).unref()
    this.addCleanup(() => {
      clearInterval(timer)
      for (const session of sessions.values()) session.controller?.abort()
      sessions.clear()
      activeLogins.clear()
    })
    try {
      const { service: api } = await service()
      await Promise.all([api.adoptPartnerAccount(), api.recoverTasks()])
    } catch (error) {
      globalThis.logger?.debug?.(`[media] 音乐目录初始化：${error.message}`)
    }
  }
  async help(e = this.e) { await replyText(e, "点歌：#网易点歌 歌名 / #QQ点歌 歌名 / #酷狗点歌 歌名\n也支持酷我、咪咕、汽水；#点歌 默认网易云。搜索后输入数字选歌，#下一页 翻页，#取消 结束。默认发送音乐卡片和完整语音，播放自动回退音源。建议主人 #音乐登录 扫码；网易云与 #合伙人登录 共用账号。");return true }
  async search() {
    const e = this.e
    try {
      const { service: api, config } = await service()
      const match = String(e.msg).match(/^#(?:荷花)?(网易云|网易|QQ音乐|QQ|qq|酷狗|酷我|咪咕|汽水)?(?:点歌|搜歌)\s*([\s\S]*)$/)
      const keyword = match?.[2]?.trim()
      if (!keyword) return this.help(e)
      const key = musicSessionKey(e), previous = sessions.get(key)
      previous?.controller?.abort()
      const session = { stage: "search", api, platform: aliases[match[1]] || config.default_platform || "netease", keyword, page: 1, expires: Date.now() + (config.session_timeout_ms || 120000), config }
      sessions.set(key, session)
      try { await this.results(session, e) }
      catch (error) {
        if (sessions.get(key) !== session) return true
        sessions.delete(key)
        throw error
      }
    } catch (error) { await replyText(e, `[media] 点歌：${error.message}`) }
    return true
  }
  async results(session, e = this.e) {
    const key = musicSessionKey(e)
    session.loading = true
    let search
    try {
      search = await session.api.search(session.platform, session.keyword, session.page)
      if (sessions.get(key) !== session) return
      session.tracks = search.tracks
      session.expires = Date.now() + (session.config.session_timeout_ms || 120000)
    } finally { session.loading = false }
    const { tracks, accountStatus } = search
    const message = tracks.length ?
      "两分钟内回复数字选歌。#下一页 翻页，#取消 结束。播放时自动尝试完整备用音源。" + searchAccountNotes[accountStatus] :
      "没有搜索结果，可更换关键词或平台。"
    const image = await renderStatusCard({ title: MUSIC_PLATFORMS[session.platform] + "点歌", subtitle: session.keyword, badge: `第 ${session.page} 页`, userId: e.user_id,
      message,
      items: tracks.map((track, i) => ({ label: String(i + 1), value: `${track.name} · ${track.artists?.map(a => a.name).join(" / ") || "未知歌手"}` })) }, { saveId: `media-music-search-${e.user_id}` }).catch(() => undefined)
    if (sessions.get(key) === session) await replyImage(e, image, [message, ...tracks.map((track, i) => `${i + 1}. ${track.name}`)].join("\n"))
  }
  async login() {
    const e = this.e
    if (!canManageMusic(e)) { await replyText(e, "请由机器人主人在私聊维护公共音乐账号。");return true }
    try {
      const { service: api, config } = await service(), platforms = (await api.platforms()).filter(p => p.capabilities.includes("qr_login"))
      if (!platforms.length) throw new Error("当前 TuneWeave 没有可扫码的平台。")
      const key = musicSessionKey(e);sessions.get(key)?.controller?.abort()
      sessions.set(key, { stage: "platform", api, platforms, expires: Date.now() + (config.session_timeout_ms || 120000), config })
      await replyText(e, "请选择扫码平台：\n" + platforms.map((p, i) => `${i + 1}. ${p.name}`).join("\n") + "\n输入数字继续，#取消 退出。网易云与合伙人登录共用。")
    } catch (error) { await replyText(e, `[media] 音乐：${error.message}`) }
    return true
  }
  async partnerLogin() {
    const e = this.e
    const config = await loadGlobalConfig()
    if (!e.isPrivate || !ownerPermission(e, config)) {
      await replyText(e, "请由机器人主人在私聊登录音乐合伙人账号。")
      return true
    }

    const key = musicSessionKey(e)
    sessions.get(key)?.controller?.abort()
    const api = new MusicService({ tuneweaveConfig: config.tuneweave })
    const session = {
      api, platform: "netease", partner: true,
      timeoutMs: loginTime(config.netease_partner?.login_timeout_ms, 300000),
      pollMs: loginTime(config.netease_partner?.login_poll_ms, 3000),
    }
    sessions.set(key, session)
    try { await this.qr(session, key, undefined, e) }
    catch (error) {
      if (sessions.get(key) === session) sessions.delete(key)
      await replyText(e, "[media] 音乐：合伙人登录失败："+error.message)
    }
    return true
  }

  async partnerLog() {
    const e = this.e
    const config = await loadGlobalConfig()
    if (!e.isPrivate || e.isDelegated || !ownerPermission(e, config)) {
      await replyText(e,"请由机器人主人在私聊查看合伙人日志。")
      return true
    }
    let report
    try { report = await readPartnerLog() }
    catch {
      await replyText(e,"[media] 无法读取合伙人日志。")
      return true
    }
    if (report) {
      await e.reply(makeForwardMsg(e,partnerLogNodes(report)))
    } else {
      const fallback = "合伙人日志 · 暂无日志"
      const image = await renderStatusCard({
        title:"合伙人日志", subtitle:"最近日志", badge:"空", message:`生成时间：${formatLocalDateTime()}`,
        items:[{label:"暂无日志",value:"成功 0 · 失败 0"}],
      }).catch(()=>undefined)
      await replyImage(e,image,fallback)
    }
    return true
  }

  async initializeTuneWeave() {
    const e = this.e
    const config = await loadGlobalConfig()
    if (!ownerPermission(e, config)) {
      await replyText(e, "只有机器人主人可以初始化 TuneWeave。")
      return true
    }
    try {
      const api = new TuneWeaveService({ config:config.tuneweave })
      const result = await api.initialize({ platform:"netease", onProgress:text=>replyText(e,"[media] "+text) })
      await replyText(e, "[media] TuneWeave 初始化完成 · "+result.version+" · "+apiOrigin(result.apiUrl))
    } catch (error) { await replyText(e,"[media] TuneWeave 初始化失败："+error.message) }
    return true
  }

  async tuneWeaveStatus() {
    const e = this.e
    const config = await loadGlobalConfig()
    if (!ownerPermission(e, config)) {
      await replyText(e, "只有机器人主人可以查看 TuneWeave 状态。")
      return true
    }
    const result = await new TuneWeaveService({config:config.tuneweave}).status("netease")
    const status = result.requiresUpdate ? "待更新" : result.ok ? "就绪" : "未就绪"
    await replyText(e,"[media] TuneWeave "+status+" · "+(result.version || "未知版本")+"\n"+
      apiOrigin(result.apiUrl)+"\n"+result.message)
    return true
  }

  async choice() {
    const e = this.e
    const key = musicSessionKey(e), session = sessions.get(key)
    if (!session || session.expires <= Date.now()) { session?.controller?.abort();sessions.delete(key);return false }
    const text = String(e.msg || "").trim()
    if (/^#(?:音乐)?取消$/.test(text)) { session.controller?.abort();sessions.delete(key);await replyText(e,"已取消本次音乐操作。");return true }
    try {
      if (session.stage === "search") {
        if (session.loading) { await replyText(e, "正在搜索，请稍候。");return true }
        if (/^#(?:音乐)?下一页$/.test(text)) {session.page++;try{await this.results(session,e)}catch(error){session.page--;throw error}return true}
        const track = session.tracks?.[Number(text.replace(/^#听/, "")) - 1]
        if (!track) { await replyText(e,`请输入 1–${session.tracks?.length || 0} 的序号。`);return true }
        sessions.delete(key)
        await replyText(e,`正在获取《${track.name}》完整音源…`)
        let media
        try {
          media = await session.api.prepare(track)
          await sendTrackInfo(e, track, media)
          await sendVoice(e, media)
        } finally {if(media)await session.api.cleanup(media)}
      } else {
        if (!canManageMusic(e)) throw new Error("请由机器人主人在私聊维护公共音乐账号。")
        const index=Number(text)-1
        if(session.stage==="platform") {
          const selected=session.platforms[index];if(!selected)throw new Error("请选择列表中的平台序号")
          session.platform=selected.platform
          if(MUSIC_QR_TYPES[session.platform]){session.stage="type";session.types=MUSIC_QR_TYPES[session.platform];await replyText(e,"请选择扫码方式：\n"+session.types.map((t,i)=>`${i+1}. ${t.name}`).join("\n"));return true}
          await this.qr(session,key,undefined,e)
        } else if(session.stage==="type") {
          const type=session.types[index];if(!type)throw new Error("请选择列表中的扫码方式序号")
          await this.qr(session,key,type.type,e)
        }
      }
    } catch(error) {await replyText(e,`[media] 音乐：${error.message}`)}
    return true
  }
  async qr(session,key,type,e = this.e) {
    if (activeLogins.has(session.platform)) throw new Error("这个平台已有扫码操作，请等它结束。")
    activeLogins.set(session.platform, session)
    session.stage = "polling"
    session.expires = Date.now() + (session.timeoutMs || 180000)
    session.controller = new AbortController()
    const signal = e.privateCredentialSignal
      ? AbortSignal.any([session.controller.signal, e.privateCredentialSignal]) : session.controller.signal
    try {
      if (session.partner) await session.api.tuneweave.requireReady("netease")
      if (signal.aborted || sessions.get(key) !== session) return
      const login=await session.api.createLogin(session.platform,e.user_id,type)
      if (signal.aborted || sessions.get(key) !== session) return
      const image = await renderTemplate("qr-login",{title:MUSIC_PLATFORMS[session.platform]+"登录",subtitle:session.partner ? "音乐合伙人" : "公共音乐账号",badge:"SCAN",notice:"建议使用对应平台 App 扫码确认。账号供机器人点歌使用，#取消 可结束等待。",qrDataUrl:login.image,profileId:session.platform}).catch(() => undefined)
      if (signal.aborted || sessions.get(key) !== session) return
      const prefix = "data:image/png;base64,"
      const qr = image || (login.image.startsWith(prefix) && Buffer.from(login.image.slice(prefix.length), "base64"))
      if (!qr || !await e.reply(globalThis.segment.image(qr))) throw new Error("音乐登录二维码发送失败。")
      await session.api.waitLogin(login, { signal, timeoutMs:session.timeoutMs, pollMs:session.pollMs })
      if (!signal.aborted && session.partner) {
        const done = "网易云合伙人账号已登录。"
        const image = await renderStatusCard({title:"合伙人登录",subtitle:"音乐合伙人",message:done}).catch(()=>undefined)
        if (!signal.aborted) await replyImage(e,image,done)
      } else if(!signal.aborted)await replyText(e,`${MUSIC_PLATFORMS[session.platform]}公共音乐账号已登录。`)
    } catch(error) {if(!signal.aborted)throw error}
    finally {
      if (activeLogins.get(session.platform) === session) activeLogins.delete(session.platform)
      if (sessions.get(key) === session) sessions.delete(key)
    }
  }
}
