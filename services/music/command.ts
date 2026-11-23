import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import type { RecallOwnReply, ReplyOptions } from "../../../../lib/messages.ts"
import { join } from "node:path"
import { enablePartnerAfterLogin } from "../../../../lib/panel-partner.ts"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderStatusCard, renderTemplate } from "../../core/render/service.ts"
import { formatLocalDateTime } from "../../core/time.ts"
import { safeMediaName, sendMediaFile } from "../media/files.ts"
import { downloadMedia } from "../media/download.ts"
import { createMediaTask, releaseMediaTask } from "../media/tasks.ts"
import { TuneWeaveService } from "../tuneweave/service.ts"
import { cloudHelp, createCloudCommands } from "./cloud-command.ts"
import { episodeSelectionFromTrack, neteaseEpisodePage, type VoiceSearchSelection } from "./episode.ts"
import { readPartnerLog, partnerLogNodes } from "./partner-log.ts"
import { NeteasePartnerTask, type PartnerConfig, type PartnerReport } from "./partner-task.ts"
import { MusicService, MUSIC_PLATFORMS, MUSIC_QR_TYPES, musicLoginTimeout, musicSessionKey, musicShare, type MusicStream, type MusicTrack, type MusicConfig } from "./service.ts"
import { findMusicShare, parseMusicShare, resolveMusicShare } from "./share-link.ts"
import { externalMusicLabels, readExternalMusicShare } from "./external-share.ts"

const aliases: Readonly<Record<string, string>> = {
  网易云: "netease", 网易: "netease", QQ: "qq", qq: "qq", QQ音乐: "qq",
  酷狗: "kugou", 酷我: "kuwo", 咪咕: "migu", 汽水: "soda",
}
const featureNames = ["[media] 点歌"] as const
const maxInlineBytes = 16 * 1024 * 1024
const mvByteLimit = 100 * 1024 * 1024
const searchCommand = /^#(网易云|网易|QQ音乐|QQ|qq|酷狗|酷我|咪咕|汽水)?(?:点歌|搜歌)\s*([\s\S]*)$/u
const typedSearch = /^#点歌\s*(\S(?:[\s\S]*?\S)?)\s+([12])$/u
const playCommand = /^#播放\s*([\s\S]*?)(?:\s+([12]))?$/u
const naturalMusic = /^(#)?(网易云|网易|QQ音乐|QQ|qq|酷狗|酷我|咪咕|汽水)?(点播音乐|点播|点歌|播放|放一?首|来一?首)([^\r\n]*)$/u
const multipleMusic = /^#?(?:多选(网易云|网易|QQ音乐|QQ|qq|酷狗|酷我|咪咕|汽水)?|(网易云|网易|QQ音乐|QQ|qq|酷狗|酷我|咪咕|汽水)多选)(?:点播音乐|点播|点歌|播放|放一?首|来一?首)([^\r\n]*)$/u
const multiplePageSize = 20
const maxMultipleResults = 500
const defaultMultipleTimeoutMs = 180_000
const nextPage = /^#?(?:音乐)?下一页$/u
const unrelatedMedia = /^(?:[#/]|https?:\/\/|[a-z]:[\\/]|(?:B站|哔哩哔哩|抖音|视频|电影|直播|文件|附件|图片|录像|歌曲链接|音频链接)(?:$|\s|[：:]))|\.(?:mp[34]|mkv|mov|wav|flac|avi)(?:[?#].*)?$/iu
const choiceCommand = /^(?:[0-9]+|#听[0-9]+|#(?:音乐)?下一页|#(?:取消|音乐取消))$/u
const reissueCommand = /^#?(歌词|语音|高清语音)(?:\s*([1-9][0-9]{0,2}))?$/u
const partnerManualCommand = /^#合伙人测试(?:[（(]执行[）)])?$/u
const playHelp = "#播放 关键词 1 直接播放首条歌曲，网易云可用 #播放 关键词 2 直接播放首期播客，或 #点歌 关键词 2 列出节目后选择。\n#多选点歌 关键词 保留跨页编号，回复一个数字选一首，可反复选择。选曲后可发 #歌词 或 #语音。在列表中可加序号。"
const help = "点歌：#网易点歌 歌名 / #QQ点歌 歌名 / #酷狗点歌 歌名\n也支持酷我、咪咕、汽水；#点歌 默认网易云。搜索后输入数字选歌，#下一页 翻页，#取消 结束。默认发送音乐卡片和完整语音。建议主人 #音乐登录 扫码；网易云与 #合伙人登录 共用账号。\n" + playHelp
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
type SearchMenu = { retired: boolean; timer?: ReturnType<typeof setTimeout>; recall?: RecallOwnReply }
type CloudSearch = NonNullable<Awaited<ReturnType<ReturnType<typeof createCloudCommands>["search"]>>>
type SearchSession = SessionBase & { readonly stage: "search"; readonly platform: string; readonly keyword: string;
  readonly timeoutMs: number; readonly podcast: boolean; readonly multiple?: true; page: number; tracks?: readonly MusicTrack[];
  exhausted?: boolean; menu?: SearchMenu;
  episodes?: Awaited<ReturnType<MusicService["searchEpisodes"]>>; cloud?: CloudSearch; loading?: boolean }
type PublicSelection = { readonly track: MusicTrack } | { readonly episode: VoiceSearchSelection }
type ReissueSelection = { readonly source: PublicSelection; readonly controller: AbortController; expires: number; busy: boolean }
type Scan = { readonly api: MusicService; readonly platform: string; readonly partner?: true; readonly timeoutMs?: number; readonly pollMs?: number }
type ScanSession = SessionBase & Scan & { readonly stage: "polling"; readonly controller: AbortController }
type Session = SearchSession | ScanSession |
  (SessionBase & { readonly stage: "platform"; readonly platforms: readonly Menu[] }) |
  (SessionBase & { readonly stage: "type"; readonly platform: string; readonly types: readonly ScanType[] })
type PartnerJob = { readonly controller: AbortController;
  promise?: ReturnType<NeteasePartnerTask["execute"]> }

function legacyMusicRequest(message: string, context: Context) {
  if (context.isDelegated || (context.message_type !== "group" && context.message_type !== "private")) return
  const multiple = multipleMusic.exec(message)
  if (multiple) {
    const provider = multiple[1] ?? multiple[2]
    const keyword = (multiple[3] ?? "").replace(/^\s*[:：]?\s*/u, "").trim()
    if (keyword.length > 150 || unrelatedMedia.test(keyword)) return
    return { action: "search" as const, keyword, platform: provider ? aliases[provider] : undefined, multiple: true as const }
  }
  const match = naturalMusic.exec(message)
  if (!match?.[3]) return
  const [, prefix, provider, phrase, rest = ""] = match
  const separated = /^[\s:：]/u.test(rest)
  if (!prefix && !provider && (phrase === "点播" || phrase === "点歌" || phrase === "播放") && !separated) return
  const keyword = rest.replace(/^\s*[:：]?\s*/u, "").trim()
  if (!keyword || keyword.length > 150 || keyword === "歌" || unrelatedMedia.test(keyword)) return
  return { action: phrase === "点歌" ? "search" as const : "directPlay" as const, keyword,
    platform: provider ? aliases[provider] : undefined }
}
interface Services {
  readonly signal?: AbortSignal
  readonly mediaRuntime?: { whenReady(start: () => void): () => void }
  readonly openMusic?: typeof defaultOpenMusic
  readonly fetchMusicShare?: typeof globalThis.fetch
  readonly renderMusicShare?: typeof renderStatusCard
}

const musicNames: Readonly<Record<string, string>> = MUSIC_PLATFORMS
const root = new URL("../../../../", import.meta.url)
const scanTypes: Readonly<Record<string, readonly ScanType[]>> = MUSIC_QR_TYPES
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请稍后重试。"
const loginTime = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : fallback

function configFields(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function ownerPermission(context: Context, config: { readonly permissions?: unknown }) {
  if (context.canManagePackages !== true || context.isDelegated) return false
  const { scopes, ...permissions } = configFields(config.permissions)
  return new PermissionService({ permissions: { ...permissions, scopes: {
    "netease.partner": { policy: "master_only" }, ...configFields(scopes),
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

function reissueTarget(message: string, context: Context) {
  const valid = (id?: number) => typeof id === "number" && Number.isSafeInteger(id) && id > 0
  if (context.isDelegated || (context.message_type !== "group" && context.message_type !== "private") ||
      !valid(context.self_id) || !valid(context.user_id) || (context.message_type === "group" && !valid(context.group_id))) return
  const match = reissueCommand.exec(message)
  if (match?.[1]) return { mode: match[1], index: match[2] ? Number(match[2]) - 1 : undefined }
}

function lyricPages(body: string) {
  const clean = body.split(/\r?\n/u).map(line => line.replace(/^(?:\[[^\]]{1,40}\])+\s*/u, "").trim()).filter(Boolean).join("\n")
  return clean.match(/[\s\S]{1,1200}/gu) ?? []
}

class MusicFeatureDisabled extends Error {}

async function defaultOpenMusic() {
  const config = await loadGlobalConfig()
  const music = config.music as Partial<MusicConfig>
  const tools = config.tools as { bin_dir?: string }
  if (music.enable === false) throw new MusicFeatureDisabled("点歌功能已关闭")
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

export function createMusicCommands({ signal, mediaRuntime, openMusic = defaultOpenMusic, fetchMusicShare,
  renderMusicShare = renderStatusCard }: Services) {
  const sessions = new Map<string, Session>()
  const pendingSearches = new Map<string, { readonly multiple: boolean }>()
  const selections = new Map<string, ReissueSelection>()
  const activeLogins = new Map<string, ScanSession>()
  const stopped = new AbortController()
  const moduleSignal = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal
  const cloud = createCloudCommands({ signal: moduleSignal, ownerSignal: credentialScope, open: async () => (await openMusic()).api,
    sendVoice, accountBusy: () => activeLogins.has("netease") })
  let partnerJob: PartnerJob | undefined
  let recovery: Promise<unknown> | undefined

  function forget(key: string) {
    selections.get(key)?.controller.abort()
    selections.delete(key)
  }

  function remember(key: string, source: PublicSelection, timeoutMs: number) {
    forget(key)
    const oldest = selections.keys().next().value
    if (selections.size >= 2048 && oldest) forget(oldest)
    const selection = { source, controller: new AbortController(), expires: Date.now() + timeoutMs, busy: false }
    selections.set(key, selection)
    return selection
  }

  function selectionAt(key: string) {
    const selection = selections.get(key)
    if (selection && selection.expires <= Date.now()) {
      forget(key)
      return
    }
    return selection
  }

  function drop(key: string, session: Session) {
    if (session.stage === "polling") session.controller.abort()
    if (session.stage === "search") retireMenu(session)
    if (sessions.get(key) === session) sessions.delete(key)
  }

  function retireMenu(session: SearchSession) {
    const menu = session.menu
    if (!menu) return
    session.menu = undefined
    menu.retired = true
    clearTimeout(menu.timer)
    void menu.recall?.()
  }

  function refreshMenuExpiry(key: string, session: SearchSession) {
    session.expires = Date.now() + session.timeoutMs
    const menu = session.menu
    if (!menu) return
    clearTimeout(menu.timer)
    menu.timer = setTimeout(() => {
      if (sessions.get(key) === session && session.menu === menu) drop(key, session)
    }, session.timeoutMs).unref()
  }

  function menuReplyOptions(key: string, session: SearchSession): ReplyOptions | undefined {
    if (!session.multiple) return
    const menu: SearchMenu = { retired: false }
    session.menu = menu
    refreshMenuExpiry(key, session)
    return { onOwnReply(recall) {
      if (menu.recall) return
      menu.recall = recall
      if (menu.retired) void recall()
      else refreshMenuExpiry(key, session)
    } }
  }

  function replace(key: string, session: Session) {
    forget(key)
    const previous = sessions.get(key)
    if (previous) drop(key, previous)
    sessions.set(key, session)
  }

  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, session] of sessions) if (session.expires <= now) drop(key, session)
    for (const [key, selection] of selections) if (selection.expires <= now) forget(key)
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

  async function imageReply(context: Context, image: Uint8Array | undefined, fallback: string, options?: ReplyOptions) {
    if (!image || !await reply(context, { type: "image", file: image }, false, options)) {
      await reply(context, fallback, false, options)
    }
  }

  async function sendVoice(context: Context, media: Prepared, active = moduleSignal, recordOnly = false) {
    active.throwIfAborted()
    const name = safeMediaName(media.track.name) + ".wav"
    if (context.deliverMedia) {
      const result = await context.deliverMedia({ path: media.voiceFile, name, type: "record" })
      if (result === "confirmed") return
      if (result === "unknown") throw new Error("语音送达未确认，请在会话中核对。")
    }
    active.throwIfAborted()
    const file = Bun.file(media.voiceFile)
    if (file.size > maxInlineBytes) {
      if (recordOnly) throw new Error("完整语音超过当前会话的发送上限。")
      const result = await context.deliverMedia?.({ path: media.voiceFile, name, type: "file" })
      if (result === "confirmed") return
      if (result === "unknown") throw new Error("音乐文件送达未确认，请在会话中核对。")
      throw new Error("完整音频超过当前会话的发送上限。")
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    active.throwIfAborted()
    if (await reply(context, { type: "record", file: bytes })) return
    active.throwIfAborted()
    if (recordOnly) throw new Error("语音发送失败。")
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
    const program = track.episode_id ? neteaseEpisodePage(track.episode_id) : undefined
    const fallback = `《${track.name}》 · ${artists}${program ? `\n${program}` : ""}`
    const image = await renderStatusCard({ title: track.name, subtitle: artists,
      message: `完整音频 · ${Math.round(media.duration)} 秒`,
      items: [{ label: "实际音源", value: musicNames[media.stream.resolved_platform ?? ""] || media.stream.resolved_platform || musicNames[track.platform] }],
    }).catch(() => undefined)
    if (program && image && await reply(context, { type: "image", file: image })) await reply(context, program)
    else if (program) await reply(context, fallback)
    else await imageReply(context, image, fallback)
  }

  async function playMedia(context: Context, api: MusicService, track: MusicTrack, stream?: MusicStream, active = moduleSignal) {
    active.throwIfAborted()
    await reply(context, `正在获取《${track.name}》完整音源…`)
    const media = stream ? await api.prepareStream(track, stream, { signal: active }) : await api.prepare(track, { signal: active })
    try {
      active.throwIfAborted()
      await sendTrackInfo(context, track, media)
      await sendVoice(context, media, active)
    } finally { await api.cleanup(media) }
  }

  async function musicSharePreview(context: Context, active: AbortSignal,
    detail: { title: string; author?: string; url: string }, platform: string, hint: string) {
    const model = { title: detail.title, subtitle: [platform, detail.author].filter(Boolean).join(" · "), message: hint }
    const limit = context.inlineImageByteLimit ?? maxInlineBytes
    let image: Uint8Array | undefined = await renderMusicShare(model).catch(() => undefined)
    if (!active.aborted && image && image.byteLength > limit) image = await renderMusicShare(model, { renderScale: 2 }).catch(() => undefined)
    if (active.aborted) return
    return image && image.byteLength <= limit ? [{ type: "image" as const, file: image }, detail.url]
      : `${platform} · 《${detail.title}》${detail.author ? ` · ${detail.author}` : ""}\n${detail.url}\n${hint}`
  }

  async function handleMusicShare(context: Context, target: NonNullable<ReturnType<typeof parseMusicShare>>, play: boolean) {
    const sessionSignal = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
    const active = sessionSignal ? AbortSignal.any([moduleSignal, sessionSignal]) : moduleSignal
    try {
      active.throwIfAborted()
      const { api, timeoutMs } = await openMusic()
      if (target.kind === "external-share") {
        const metadata = await readExternalMusicShare(target, active, fetchMusicShare)
        if (active.aborted) return
        const hint = "请在原平台打开并播放。"
        if (play) return hint + "\n" + metadata.url
        return await musicSharePreview(context, active, metadata, externalMusicLabels[target.platform], hint)
      }
      const selected = await resolveMusicShare(target, active, fetchMusicShare)
      const item = await api.publicShare(selected, active)
      active.throwIfAborted()
      if (play) {
        if (item.kind === "mv") {
          const stream = await api.publicMvStream(item.mv, active)
          if (stream.size !== undefined && stream.size > mvByteLimit) throw new Error("MV 超过当前发送上限，请打开原链接。")
          active.throwIfAborted()
          const task = await createMediaTask(api.tasksDir)
          try {
            const { file, sizeBytes } = await downloadMedia(stream.url.href, join(task.dir, "mv"), {
              fetch: api.fetch, kind: "video", cdn: "netease-mv", maxBytes: mvByteLimit, timeoutMs: 60_000, signal: active,
            })
            if (!file.endsWith(".mp4") || (stream.size && stream.size !== sizeBytes)) throw new Error("MV 文件与原平台回包不一致。")
            await sendMediaFile(context, file, { file_name: safeMediaName(item.mv.title) + ".mp4", signal: active })
          } finally { await releaseMediaTask(api.tasksDir, task.dir) }
        } else if (item.kind === "episode") {
          remember(musicSessionKey(context), { episode: item.episode }, timeoutMs)
          const { track, stream } = await api.playEpisode(item.episode, active)
          await playMedia(context, api, track, stream, active)
        } else {
          remember(musicSessionKey(context), { track: item.track }, timeoutMs)
          const stream = await api.resolve(item.track, { exact: true, signal: active })
          await playMedia(context, api, item.track, stream, active)
        }
        return []
      }
      const title = item.kind === "mv" ? item.mv.title : item.kind === "episode" ? item.episode.name : item.track.name
      const author = item.kind === "mv" ? item.mv.creators?.map(value => value.name).filter(Boolean).join(" / ")
        : item.kind === "episode" ? item.episode.creator : item.track.artists?.map(value => value.name).join(" / ")
      const platform = item.kind === "mv" ? "网易云 MV" : item.kind === "episode" ? "网易云播客" : musicNames[selected.platform] ?? selected.platform
      const hint = item.kind === "mv" ? "发送 #播放 加原文链接可请求完整 MV。" : "发送 #播放 加原文链接可请求完整音源。"
      return await musicSharePreview(context, active, { title, author, url: selected.url }, platform, hint)
    } catch (error) {
      if (!active.aborted && (play || !(error instanceof MusicFeatureDisabled))) {
        return play ? "[media] 播放：" + errorText(error) : "暂时无法读取音乐链接，请在原平台打开。\n" + target.url
      }
    }
  }

  function publicSearchChoice(session: SearchSession, index: number): PublicSelection | undefined {
    const track = session.tracks?.[index]
    if (track && !session.cloud?.tracks.some(item => item.track === track)) return { track }
    const episode = session.episodes?.[index - (session.tracks?.length ?? 0)]
    if (episode) return { episode }
  }

  async function reissue(context: Context, key: string, request: NonNullable<ReturnType<typeof reissueTarget>>) {
    const current = sessions.get(key)
    let selected = selectionAt(key)
    if (request.index !== undefined) {
      if (current?.stage !== "search" || current.expires <= Date.now()) return
      if (current.loading) return "正在搜索，请稍候。"
      const source = publicSearchChoice(current, request.index)
      if (!source) return "请选当前列表里的公开歌曲或节目。"
      if (selected?.busy) return "正在处理这首曲目，请稍候。"
      selected = remember(key, source, current.timeoutMs)
    }
    if (!selected) return
    if (selected.busy) return "正在处理这首曲目，请稍候。"
    const { source, controller } = selected
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
    const active = AbortSignal.any([moduleSignal, controller.signal, ...(connection ? [connection] : [])])
    selected.busy = true
    try {
      active.throwIfAborted()
      const { api } = await openMusic()
      active.throwIfAborted()
      if (request.mode === "歌词") {
        if (!("track" in source)) return "这条播客没有通过曲目歌词入口提供歌词。"
        const lyric = await api.publicLyrics(source.track, active)
        if (active.aborted) return
        const original = lyricPages(lyric.original), translated = lyricPages(lyric.translated)
        if (!original.length && !translated.length) return "此曲目没有公开歌词。"
        return { type: "forward" as const, nodes: [`《${source.track.name}》 · 歌词`, ...original,
          ...(translated.length ? ["译词", ...translated] : [])] }
      }
      if (request.mode === "高清语音") await reply(context, "当前网关只支持普通语音，将尝试重发所选的完整音源。")
      active.throwIfAborted()
      const { track, stream } = "episode" in source ? await api.playEpisode(source.episode, active)
        : { track: source.track, stream: await api.resolve(source.track, { exact: true, signal: active }) }
      const media = await api.prepareStream(track, stream, { signal: active })
      try { await sendVoice(context, media, active, true) }
      finally { await api.cleanup(media) }
      return []
    } catch (error) {
      if (!active.aborted) return "[media] " + request.mode + "：" + errorText(error)
    } finally {
      selected.busy = false
    }
  }

  async function showResults(context: Context, key: string, session: SearchSession) {
    session.loading = true
    try {
      const api = session.api
      if (!session.multiple && session.platform === "netease" && session.page === 1) session.cloud = await cloud.search(context, api, session.keyword)
      const limit = session.multiple ? multiplePageSize : api.config.search_limit
      const start = (session.page - 1) * limit
      const matching = session.cloud?.tracks ?? []
      const requestedCloud = matching.slice(start, start + limit)
      const offset = Math.max(0, start - matching.length)
      const remaining = limit - requestedCloud.length
      const search = !session.podcast && remaining > 0 ? await api.search(session.platform, session.keyword, session.page,
        { limit: remaining, offset }) : undefined
      const episodes = session.podcast && remaining > 0 ? await api.searchEpisodes(session.keyword,
        { limit: remaining, offset, signal: moduleSignal }) : []
      if (sessions.get(key) !== session || moduleSignal.aborted) return
      const previous = session.multiple ? session.tracks ?? [] : []
      let tracks = [...requestedCloud.map(item => item.track), ...search?.tracks ?? []]
      if (session.multiple) {
        const known = new Set(previous.map(track => track.ref))
        session.exhausted = tracks.length === 0
        tracks = tracks.filter(track => {
          if (track.platform !== session.platform || !track.ref || known.has(track.ref)) return false
          known.add(track.ref)
          return true
        }).slice(0, maxMultipleResults - previous.length)
        session.exhausted ||= previous.length + tracks.length >= maxMultipleResults
      }
      session.tracks = [...previous, ...tracks]
      session.episodes = episodes
      session.expires = Date.now() + session.timeoutMs
      const results = [
        ...tracks.map((track, index) => `${track.name} · ${track.artists?.map(artist => artist.name).join(" / ") || "未知歌手"}${index < requestedCloud.length ? " · 云盘" : ""}`),
        ...episodes.map(episode => `${episode.name} · ${episode.creator || "未知主播"} · 播客`),
      ]
      const choiceHint = session.multiple ? "回复任一已显示的数字选一首，可反复选择。#下一页 翻页，#取消 结束。"
        : session.podcast ? "两分钟内回复数字选择。#下一页 翻页，#取消 结束。" :
        "两分钟内回复数字选歌。#下一页 翻页，#取消 结束。公开曲目播放时自动尝试完整备用音源。" + (search ? searchNotes[search.accountStatus] : "")
      const message = results.length ? choiceHint : session.multiple && previous.length
        ? session.exhausted ? "没有更多歌曲，仍可选择之前的编号。" : "本页没有新的歌曲，可继续翻页或选择之前的编号。"
        : "没有搜索结果，可更换关键词或平台。"
      const title = session.multiple ? `${musicNames[session.platform]}多选点歌 · 第 ${session.page} 页`
        : session.podcast ? "网易云播客" : musicNames[session.platform] + "点歌"
      const image = await renderStatusCard({ title, subtitle: session.keyword,
        badge: `第 ${session.page} 页`, userId: context.user_id, message,
        items: results.map((value, index) => ({ label: String(previous.length + index + 1), value })),
      }, requestedCloud.length ? undefined : { saveId: `media-music-search-${context.user_id}` }).catch(() => undefined)
      if (sessions.get(key) === session) {
        if (requestedCloud.length && session.cloud) await cloud.assertVisible(context, api, session.cloud.binding)
        const options = menuReplyOptions(key, session)
        await imageReply(context, image, [message, ...results.map((value, index) => `${previous.length + index + 1}. ${value}`)].join("\n"), options)
      }
    } finally {
      session.loading = false
    }
  }

  async function scan(context: Context, key: string, scanOptions: Scan, type?: string) {
    const friend = credentialScope(context)
    if (!friend) throw new Error("请由机器人主人在私聊维护公共音乐账号。")
    const { platform, api } = scanOptions
    if (platform === "netease" && (partnerJob || cloud.isUploading())) throw new Error("网易云任务正在进行，请稍候。")
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
        let done = "网易云合伙人账号已登录，定时任务已启用。"
        try {
          await enablePartnerAfterLogin(root, active, config => ownerPermission(context, config))
        } catch {
          if (active.aborted) return
          done = "网易云合伙人账号已登录，定时任务启用未确认。请检查合伙人配置或重试登录。"
        }
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
    let session = sessions.get(key)
    if (session?.stage === "search" && session.multiple && context.isDelegated) return
    if (session && session.expires <= Date.now()) {
      drop(key, session)
      session = undefined
    }
    if (/^#(?:音乐)?取消$/u.test(message)) {
      const cancelPending = !context.isDelegated && pendingSearches.delete(key)
      if (session || cancelPending || (!context.isDelegated && selectionAt(key))) {
        if (session) drop(key, session)
        if (!context.isDelegated) forget(key)
        return "已取消本次音乐操作。"
      }
      return
    }
    if (!session) return
    try {
      if (session.stage === "search") {
        if (session.loading) return session.multiple ? "正在处理点歌，请稍候。" : "正在搜索，请稍候。"
        if (nextPage.test(message)) {
          if (session.multiple && session.exhausted) return "没有更多歌曲，仍可选择之前的编号。"
          retireMenu(session)
          session.page++
          try { await showResults(context, key, session) }
          catch (error) { session.page--; throw error }
          return []
        }
        const index = Number(message.replace(/^#听/u, "")) - 1
        const trackCount = session.tracks?.length ?? 0
        const track = session.tracks?.[index]
        const episode = session.episodes?.[index - trackCount]
        if (session.multiple && !trackCount) return "当前没有可选择的歌曲。"
        if (!track && !episode) return `请输入 1–${trackCount + (session.episodes?.length ?? 0)} 的序号。`
        if (session.multiple && track) {
          session.loading = true
          refreshMenuExpiry(key, session)
          const selection = remember(key, { track }, session.timeoutMs)
          const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
          const active = AbortSignal.any([moduleSignal, selection.controller.signal, ...(connection ? [connection] : [])])
          try {
            const { api } = await openMusic()
            await playMedia(context, api, track, undefined, active)
          } catch (error) {
            if (!active.aborted) throw error
          } finally {
            session.loading = false
          }
          return []
        }
        sessions.delete(key)
        if (episode) {
          remember(key, { episode }, session.timeoutMs)
          const { track, stream } = await session.api.playEpisode(episode, moduleSignal)
          await playMedia(context, session.api, track, stream)
          return []
        }
        if (!track) return
        const cloudTrack = session.cloud?.tracks.find(item => item.track === track)
        if (cloudTrack && session.cloud) {
          forget(key)
          await cloud.play(context, session.api, session.cloud.binding, cloudTrack)
          return []
        }
        remember(key, { track }, session.timeoutMs)
        await playMedia(context, session.api, track)
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
    if (playCommand.test(message)) return "directPlay"
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
    if (cloud.matches(message)) return cloud.handle(message, context)
    const key = musicSessionKey(context)
    const followup = reissueTarget(message, context)
    if (followup) return reissue(context, key, followup)
    if (message === "下一页" && !context.isDelegated && sessions.get(key)?.stage === "search") return choose(message, context, key)
    const legacy = legacyMusicRequest(message, context)
    const selected = action(message) ?? legacy?.action
    if (!selected) {
      const share = findMusicShare(message, context)
      if (share) return handleMusicShare(context, share, false)
      return
    }
    if (selected === "choice") return choose(message, context, key)
    if (selected === "help") return credentialScope(context) ? `${help}\n${cloudHelp}` : help
    if (selected === "directPlay") {
      if (context.message_type === "terminal") return
      const direct = playCommand.exec(message)
      const keyword = direct?.[1]?.trim() ?? legacy?.keyword ?? ""
      const mode = direct?.[2]
      if (!keyword) return playHelp
      if (/^https?:\/\//iu.test(keyword)) {
        const share = parseMusicShare(keyword)
        if (!share || context.isDelegated) return
        return handleMusicShare(context, share, true)
      }
      try {
        const { api, defaultPlatform, timeoutMs } = await openMusic()
        await recovery
        moduleSignal.throwIfAborted()
        const platform = legacy?.platform ?? defaultPlatform
        if (mode === "2") {
          if (platform !== "netease") return "当前默认音乐平台未接入播客播放。"
          const episode = await api.firstEpisode(keyword, moduleSignal)
          if (!episode) return "未找到相关网易云播客。"
          const source = episodeSelectionFromTrack(episode.track)
          if (source) remember(key, { episode: source }, timeoutMs)
          await playMedia(context, api, episode.track, episode.stream)
        } else {
          const variant = platform === "netease" ? "cloud" : undefined
          const { tracks: [track] } = await api.search(platform, keyword, 1, { limit: 1, variant })
          if (!track) return "未找到相关歌曲。"
          remember(key, { track }, timeoutMs)
          await playMedia(context, api, track)
        }
      } catch (error) {
        if (!moduleSignal.aborted) return "[media] 播放：" + errorText(error)
      }
      return []
    }
    if (selected === "search") {
      const match = searchCommand.exec(message)
      const mode = typedSearch.exec(message)
      const keyword = (mode?.[1] ?? match?.[2] ?? legacy?.keyword ?? "").trim()
      if (!keyword) return help
      const multiple = legacy && "multiple" in legacy ? legacy.multiple : undefined
      const previous = sessions.get(key)
      const previousMultiple = previous?.stage === "search" && previous.multiple
      if (context.isDelegated && (previousMultiple || pendingSearches.get(key)?.multiple)) return
      if (previousMultiple) drop(key, previous)
      const request = { multiple: multiple === true }
      pendingSearches.set(key, request)
      try {
        const { api, defaultPlatform, timeoutMs } = await openMusic()
        await recovery
        if (moduleSignal.aborted || pendingSearches.get(key) !== request) return []
        const platform = aliases[match?.[1] ?? ""] || legacy?.platform || defaultPlatform
        const podcast = mode?.[2] === "2"
        if (podcast && platform !== "netease") return "当前默认音乐平台未接入播客播放。"
        const multipleTimeout = api.config.session_timeout_ms
        const sessionTimeout = multiple
          ? (multipleTimeout && multipleTimeout > 0 && multipleTimeout <= 2_147_483_647 ? multipleTimeout : defaultMultipleTimeoutMs)
          : timeoutMs
        const session: SearchSession = { stage: "search", api, platform, timeoutMs: sessionTimeout, keyword, podcast, page: 1,
          multiple, expires: Date.now() + sessionTimeout }
        replace(key, session)
        try { await showResults(context, key, session) }
        catch (error) {
          if (sessions.get(key) !== session) return []
          drop(key, session)
          throw error
        }
      } catch (error) {
        if (pendingSearches.get(key) === request) return "[media] 点歌：" + errorText(error)
      } finally {
        if (pendingSearches.get(key) === request) pendingSearches.delete(key)
      }
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
      if (cloud.matches(context.normalizedMessage)) return featureNames
      const key = musicSessionKey(context)
      const followup = reissueTarget(context.normalizedMessage, context)
      if (followup && (followup.index === undefined ? selections.has(key) : sessions.get(key)?.stage === "search")) return featureNames
      if (context.normalizedMessage === "下一页" && !context.isDelegated && sessions.get(musicSessionKey(context))?.stage === "search") return featureNames
      const selected = action(context.normalizedMessage) ?? legacyMusicRequest(context.normalizedMessage, context)?.action
      if (!selected && findMusicShare(context.normalizedMessage, context)) return featureNames
      const cancel = !context.isDelegated && /^#(?:音乐)?取消$/u.test(context.normalizedMessage)
      return selected && (selected !== "choice" || sessions.has(key) ||
        (cancel && (selections.has(key) || pendingSearches.has(key)))) ? featureNames : []
    },
    executePartner: runPartnerTask,
    renderPartner: renderPartnerReport,
    async dispose() {
      stopped.abort()
      cancelRecovery?.()
      clearInterval(timer)
      pendingSearches.clear()
      for (const [key, session] of sessions) drop(key, session)
      for (const key of selections.keys()) forget(key)
      activeLogins.clear()
      const job = partnerJob
      job?.controller.abort()
      await Promise.allSettled([recovery, job?.promise])
    },
  }
}
