import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import type { MessageFallback, MessageFallbackContext } from "../../../../lib/commands.ts"
import type { RecallOwnReply, ReplyOptions } from "../../../../lib/messages.ts"
import { nativeImageRasterScale } from "@lotus-yunzai/skia"
import { join } from "node:path"
import { enablePartnerAfterLogin } from "../../../../lib/panel-partner.ts"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { PermissionService } from "../../core/permissions/service.ts"
import { renderMusicList, renderStatusCard, renderTemplate } from "../../core/render/service.ts"
import { formatLocalDateTime } from "../../core/time.ts"
import { safeMediaName, sendMediaFile } from "../media/files.ts"
import { downloadMedia } from "../media/download.ts"
import { createMediaTask, releaseMediaTask } from "../media/tasks.ts"
import { TuneWeaveService } from "../tuneweave/service.ts"
import { cloudHelp, createCloudCommands } from "./cloud-command.ts"
import { episodeSelectionFromTrack, neteaseEpisodePage, type VoiceSearchSelection } from "./episode.ts"
import { readPartnerLog, partnerLogNodes } from "./partner-log.ts"
import { NeteasePartnerTask, type PartnerConfig, type PartnerReport } from "./partner-task.ts"
import { openPublicQqStream, ownMusicStatus, prepareOwnQqTrack, readQqCollection, recommendQqSong, refreshOwnMusicAccount, verifyQqSelection, type MusicCollection, type RefreshPlatform } from "./personal.ts"
import { MusicService, MUSIC_PLATFORMS, MUSIC_QR_TYPES, musicLoginTimeout, musicSessionKey, musicShare, type MusicStream, type MusicTrack, type MusicConfig } from "./service.ts"
import { findMusicShare, parseMusicShare, resolveMusicShare } from "./share-link.ts"
import { externalMusicLabels, readExternalMusicShare } from "./external-share.ts"
import { musicLength, musicMenuCovers, type MusicMenuRow } from "./menu.ts"
import type { MediaFetch } from "../media/cdn.ts"

const aliases: Readonly<Record<string, string>> = {
  网易云: "netease", 网易: "netease", QQ: "qq", qq: "qq", QQ音乐: "qq",
  酷狗: "kugou", 酷我: "kuwo", 咪咕: "migu", 汽水: "soda",
  哔哩哔哩: "bilibili", 哔哩: "bilibili", B站: "bilibili", b站: "bilibili",
}
const featureNames = ["[media] 点歌"] as const
const maxInlineBytes = 16 * 1024 * 1024
const mvByteLimit = 100 * 1024 * 1024
const searchCommand = /^#(网易云|网易|QQ音乐|QQ|qq|酷狗|酷我|咪咕|汽水|哔哩哔哩|哔哩|[Bb]站)?(?:点歌|搜歌)\s*([\s\S]*)$/u
const typedSearch = /^#点歌\s*(\S(?:[\s\S]*?\S)?)\s+([12])$/u
const playCommand = /^#播放\s*([\s\S]*?)(?:\s+([12]))?$/u
const naturalMusic = /^(#)?(网易云|网易|QQ音乐|QQ|qq|酷狗|酷我|咪咕|汽水|哔哩哔哩|哔哩|[Bb]站)?(点播音乐|点播|点歌|播放|放一?首|来一?首)([^\r\n]*)$/u
const multipleMusic = /^#?(?:多选(网易云|网易|QQ音乐|QQ|qq|酷狗|酷我|咪咕|汽水|哔哩哔哩|哔哩|[Bb]站)?|(网易云|网易|QQ音乐|QQ|qq|酷狗|酷我|咪咕|汽水|哔哩哔哩|哔哩|[Bb]站)多选)(?:点播音乐|点播|点歌|播放|放一?首|来一?首)([^\r\n]*)$/u
const multiplePageSize = 20
const maxMultipleResults = 500
const defaultMultipleTimeoutMs = 180_000
const nextPage = /^#?(?:音乐)?下一页$/u
const unrelatedMedia = /^(?:[#/]|https?:\/\/|[a-z]:[\\/]|(?:B站|哔哩哔哩|抖音|视频|电影|直播|文件|附件|图片|录像|歌曲链接|音频链接)(?:$|\s|[：:]))|\.(?:mp[34]|mkv|mov|wav|flac|avi)(?:[?#].*)?$/iu
const choiceCommand = /^(?:[0-9]+|#听[0-9]+|#(?:音乐)?下一页|#(?:取消|音乐取消))$/u
const reissueCommand = /^#?(歌词|语音|高清语音)(?:\s*([1-9][0-9]{0,2}))?$/u
const partnerManualCommand = /^#合伙人测试(?:[（(]执行[）)])?$/u
const playHelp = $t("services.music.command.text_d126aad504")
const help = $t("services.music.command.text_b4d32554ee") + playHelp
const recommendation = /^#?(?:来|放)(?:一)?首歌$/u
const favorite = /^#?(?:我的收藏|我喜欢的歌)(?:\s*([0-9]{1,4}))?$/u
const accountStatus = /^#?(?:音乐登录状态|(?:点歌|音乐)(?:ck|cookie)(?:检查|状态))$/iu
const refreshMusic = /^#刷新(网易云|QQ|酷狗|汽水|酷我|咪咕)音乐登录$/iu
const collectionName = { radio: $t("services.music.command.text_69ac3e0dbb"), daily: $t("services.music.command.text_befbde1df6"), favorites: $t("services.music.command.text_ecb599961f") } as const
const searchNotes: Readonly<Record<string, string>> = {
  selected: $t("services.music.command.text_d5eb7c3bb4"),
  unverified: $t("services.music.command.text_5e5f1104d0"),
  unconfigured: $t("services.music.command.text_2502a798a8"),
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
  readonly controller: AbortController; readonly timeoutMs: number; readonly podcast: boolean; readonly multiple?: true; page: number;
  tracks?: readonly MusicTrack[];
  readonly collection?: MusicCollection; binding?: Awaited<ReturnType<typeof readQqCollection>>["binding"];
  exhausted?: boolean; menu?: SearchMenu;
  episodes?: Awaited<ReturnType<MusicService["searchEpisodes"]>>; cloud?: CloudSearch; loading?: boolean }
type PublicSelection = { readonly track: MusicTrack } | { readonly episode: VoiceSearchSelection }
type ReissueSelection = { readonly source: PublicSelection; readonly controller: AbortController; expires: number; busy: boolean }
type Scan = { readonly api: MusicService; readonly platform: string; readonly partner?: true; readonly force?: boolean;
  readonly timeoutMs?: number; readonly pollMs?: number }
type ScanSession = SessionBase & Scan & { readonly stage: "polling"; readonly controller: AbortController }
type Session = SearchSession | ScanSession |
  (SessionBase & { readonly stage: "platform"; readonly platforms: readonly Menu[]; readonly force?: boolean }) |
  (SessionBase & { readonly stage: "type"; readonly platform: string; readonly types: readonly ScanType[]; readonly force?: boolean })
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
  readonly fetchMusicCover?: MediaFetch
  readonly renderMusicMenu?: typeof renderMusicList
}

const musicNames: Readonly<Record<string, string>> = { ...MUSIC_PLATFORMS, bilibili: $t("services.music.command.text_fb982fc3c0") }
const root = new URL("../../../../", import.meta.url)
const scanTypes: Readonly<Record<string, readonly ScanType[]>> = MUSIC_QR_TYPES
const errorText = (error: unknown) => error instanceof Error ? error.message : $t("services.music.command.text_8977b79aa8")
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

function personalAction(message: string) {
  if (recommendation.test(message)) return { kind: "recommend" as const }
  if (accountStatus.test(message)) return { kind: "status" as const }
  const refresh = refreshMusic.exec(message)
  if (refresh) return { kind: "refresh" as const, platform: aliases[refresh[1]!.toLowerCase()] as RefreshPlatform }
  const stars = favorite.exec(message)
  if (stars) return { kind: "collection" as const, collection: "favorites" as const, page: Number(stars[1] ?? 1) }
  if (/^#?个性电台$/u.test(message)) return { kind: "collection" as const, collection: "radio" as const, page: 1 }
  if (/^#?(?:每日推荐|每日30首|日推)$/u.test(message)) return { kind: "collection" as const, collection: "daily" as const, page: 1 }
}

function apiOrigin(address: unknown) {
  const url = typeof address === "string" && URL.parse(address)
  return url && ["http:", "https:"].includes(url.protocol) ? url.origin : $t("services.music.command.text_f99b4f94d7")
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
  if (music.enable === false) throw new MusicFeatureDisabled($t("services.music.command.text_151936d69e"))
  return { api: new MusicService({ tuneweaveConfig: config.tuneweave, config: music, toolsPath: tools.bin_dir }),
    defaultPlatform: music.default_platform || "netease", timeoutMs: music.session_timeout_ms || 120000 }
}

async function renderPartnerReport(title: string, report: PartnerReport, userId?: number) {
  const items = report.accounts.map(account => ({
    label: account.nickname,
    value: $t("services.music.command.text_3a3c664232", { "success": account.success, "fail": account.fail }),
  }))
  const image = await renderStatusCard({ title, subtitle: report.trigger, badge: report.accounts.some(account => account.fail) ? $t("services.music.command.text_eedce9bb59") : $t("services.music.command.text_c0b3fbff51"),
    message: $t("services.music.command.text_b417f4d805", { "time": report.time }), userId, items,
  }).catch(() => undefined)
  return { image, text: [title, ...items.map(item => `${item.label}：${item.value}`)].join("\n") }
}

export function createMusicCommands({ signal, mediaRuntime, openMusic = defaultOpenMusic, fetchMusicShare,
  renderMusicShare = renderStatusCard, fetchMusicCover, renderMusicMenu = renderMusicList }: Services) {
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
    if (selection && !selection.busy && selection.expires <= Date.now()) {
      forget(key)
      return
    }
    return selection
  }

  function drop(key: string, session: Session) {
    if (session.stage === "polling" || session.stage === "search") session.controller.abort()
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
    if (!session.multiple && !session.collection) return
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
    for (const [key, selection] of selections) if (!selection.busy && selection.expires <= now) forget(key)
  }, 30_000).unref()
  const cancelRecovery = mediaRuntime?.whenReady(() => {
    if (moduleSignal.aborted) return
    recovery = (async () => {
      const { api } = await openMusic()
      if (!moduleSignal.aborted) await Promise.all([api.adoptPartnerAccount(), api.recoverTasks()])
    })().catch(error => {
      if (!moduleSignal.aborted) console.debug($t("services.music.command.text_f3b0da1d72") + errorText(error))
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

  async function imageReply(context: Context, image: Uint8Array | undefined, fallback: string, options?: ReplyOptions, active = moduleSignal) {
    if (active.aborted) return
    if (!image || !await reply(context, { type: "image", file: image }, false, options)) {
      if (!active.aborted) await reply(context, fallback, false, options)
    }
  }

  async function sendVoice(context: Context, media: Prepared, active = moduleSignal, recordOnly = false) {
    active.throwIfAborted()
    const name = safeMediaName(media.track.name) + ".wav"
    if (context.deliverMedia) {
      const result = await context.deliverMedia({ path: media.voiceFile, name, type: "record" })
      if (result === "confirmed") return
      if (result === "unknown") throw new Error($t("services.music.command.text_171da13881"))
    }
    active.throwIfAborted()
    const file = Bun.file(media.voiceFile)
    if (file.size > maxInlineBytes) {
      if (recordOnly) throw new Error($t("services.music.command.text_f95f070248"))
      const result = await context.deliverMedia?.({ path: media.voiceFile, name, type: "file" })
      if (result === "confirmed") return
      if (result === "unknown") throw new Error($t("services.music.command.text_3fcdd59cfb"))
      throw new Error($t("services.music.command.text_e9c47f1a9d"))
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    active.throwIfAborted()
    if (await reply(context, { type: "record", file: bytes })) return
    active.throwIfAborted()
    if (recordOnly) throw new Error($t("services.music.command.text_17a796969c"))
    const result = await context.uploadFile?.({ name, bytes })
    if (result === "confirmed") return
    if (result === "unknown") throw new Error($t("services.music.command.text_3fcdd59cfb"))
    throw new Error($t("services.music.command.text_17a796969c"))
  }

  async function sendTrackInfo(context: Context, track: MusicTrack, media: Prepared, active = moduleSignal,
    verify?: () => Promise<void>) {
    active.throwIfAborted()
    const share = musicShare(track, media.stream)
    if (share && context.sendMusicCard) {
      await verify?.()
      active.throwIfAborted()
      const result = await context.sendMusicCard(share.data)
      if (result === "confirmed") return
      if (result === "unknown") {
        if (!active.aborted) await reply(context, $t("services.music.command.text_01b3bd79f0"))
        return
      }
    }
    const artists = track.artists?.map(artist => artist.name).join(" / ") || $t("services.music.command.text_f374d78a34")
    const program = track.episode_id ? neteaseEpisodePage(track.episode_id) : track.platform === "bilibili" ? track.extensions?.url : undefined
    const fallback = `《${track.name}》 · ${artists}${program ? `\n${program}` : ""}`
    const image = await renderStatusCard({ title: track.name, subtitle: artists,
      message: $t("services.music.command.text_cb843c7432", { "value1": Math.round(media.duration) }),
      items: [{ label: $t("services.music.command.text_3e2494b386"), value: musicNames[media.stream.resolved_platform ?? ""] || media.stream.resolved_platform || musicNames[track.platform] }],
    }).catch(() => undefined)
    active.throwIfAborted()
    await verify?.()
    active.throwIfAborted()
    if (program && image && await reply(context, { type: "image", file: image })) {
      active.throwIfAborted()
      await reply(context, program)
    }
    else if (program) await reply(context, fallback)
    else await imageReply(context, image, fallback, undefined, active)
  }

  async function playMedia(context: Context, api: MusicService, track: MusicTrack, stream?: MusicStream, active = moduleSignal) {
    active.throwIfAborted()
    await reply(context, $t("services.music.command.text_7f0fc7fa5b", { "name": track.name }))
    active.throwIfAborted()
    const media = stream ? await api.prepareStream(track, stream, { signal: active }) : await api.prepare(track, { signal: active })
    await sendPreparedTrack(context, api, track, media, active)
  }

  function playbackSignal(context: Context, selection?: ReissueSelection) {
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
    return AbortSignal.any([moduleSignal, ...(connection ? [connection] : []), ...(selection ? [selection.controller.signal] : [])])
  }

  async function playSelection(context: Context, key: string, source: PublicSelection, timeoutMs: number,
    play: (active: AbortSignal) => Promise<void>) {
    const selection = remember(key, source, timeoutMs)
    const active = playbackSignal(context, selection)
    selection.busy = true
    try { await play(active) }
    catch (error) { if (!active.aborted) throw error }
    finally {
      selection.busy = false
      selection.expires = Date.now() + timeoutMs
    }
  }

  async function sendPreparedTrack(context: Context, api: MusicService, track: MusicTrack, media: Prepared, active: AbortSignal,
    verify?: () => Promise<void>) {
    try {
      active.throwIfAborted()
      await sendTrackInfo(context, track, media, active, verify)
      await verify?.()
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
        const hint = $t("services.music.command.text_9c3b99905a")
        if (play) return hint + "\n" + metadata.url
        return await musicSharePreview(context, active, metadata, externalMusicLabels[target.platform], hint)
      }
      const selected = await resolveMusicShare(target, active, fetchMusicShare)
      const item = await api.publicShare(selected, active)
      active.throwIfAborted()
      if (play) {
        if (item.kind === "mv") {
          const stream = await api.publicMvStream(item.mv, active)
          if (stream.size !== undefined && stream.size > mvByteLimit) throw new Error($t("services.music.command.text_288f81c2da"))
          active.throwIfAborted()
          const task = await createMediaTask(api.tasksDir)
          try {
            const transfer = AbortSignal.any([active, AbortSignal.timeout(60_000)])
            let file: string | undefined
            let failure: unknown
            for (const url of stream.urls) {
              transfer.throwIfAborted()
              try {
                const result = await downloadMedia(url, join(task.dir, "mv"), {
                  fetch: (address, request) => {
                    if (stream.matchesUrl && !stream.matchesUrl(new URL(address))) throw new Error($t("services.music.command.text_53613a19d0"))
                    return api.fetch(address, request)
                  },
                  kind: "video", cdn: stream.cdn, maxBytes: mvByteLimit, timeoutMs: 60_000, signal: transfer,
                })
                if (!result.file.endsWith(".mp4") || (stream.size && stream.size !== result.sizeBytes)) {
                  throw new Error($t("services.music.command.text_b7ab940103"))
                }
                file = result.file
                break
              } catch (error) { failure = error }
            }
            if (!file) throw failure ?? new Error($t("services.music.command.text_165cc88a6c"))
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
      const source = selected.platform === "kuwo" && selected.url.startsWith("https://h5app.kuwo.cn/") ? $t("services.music.command.text_e8bc4564b5")
        : selected.platform === "soda" ? $t("services.music.command.text_f8cff81f62") : MUSIC_PLATFORMS[selected.platform]
      const platform = item.kind === "mv" ? source + " MV" : item.kind === "episode" ? $t("services.music.command.text_9b139653d2") : source
      const hint = item.kind === "mv" ? $t("services.music.command.text_fb34d8040a") : $t("services.music.command.text_2a386db9ed")
      return await musicSharePreview(context, active, { title, author, url: selected.url }, platform, hint)
    } catch (error) {
      if (!active.aborted && (play || !(error instanceof MusicFeatureDisabled))) {
        return play ? $t("services.music.command.text_d3a5a0bdfd") + errorText(error) : $t("services.music.command.text_159b972124") + target.url
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
      if (current.loading) return $t("services.music.command.text_c3c2f34d94")
      const source = publicSearchChoice(current, request.index)
      if (!source) return $t("services.music.command.text_941bfdc1dc")
      if (selected?.busy) return $t("services.music.command.text_b0d3ab706d")
      selected = remember(key, source, current.timeoutMs)
    }
    if (!selected) return
    if (selected.busy) return $t("services.music.command.text_b0d3ab706d")
    const { source, controller } = selected
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
    const active = AbortSignal.any([moduleSignal, controller.signal, ...(connection ? [connection] : [])])
    selected.busy = true
    try {
      active.throwIfAborted()
      const { api } = await openMusic()
      active.throwIfAborted()
      if (request.mode === "歌词") {
        if ("episode" in source) {
          const transcript = await api.episodeTranscript(source.episode, active)
          if (active.aborted) return
          if (!transcript) return $t("services.music.command.text_aa70b642cb")
          return { type: "forward" as const, nodes: [$t("services.music.command.text_19c21cb395", { "name": source.episode.name }),
            ...transcript.match(/[\s\S]{1,1000}/gu) ?? [], neteaseEpisodePage(source.episode.id)] }
        }
        if (source.track.platform === "bilibili") return $t("services.music.command.text_e33a4d7ec9")
        const lyric = await api.publicLyrics(source.track, active)
        if (active.aborted) return
        const original = lyricPages(lyric.original), translated = lyricPages(lyric.translated)
        if (!original.length && !translated.length) return $t("services.music.command.text_a2cec7650e")
        return { type: "forward" as const, nodes: [$t("services.music.command.text_b58589b85f", { "name": source.track.name }), ...original,
          ...(translated.length ? [$t("services.music.command.text_d84c9eee14"), ...translated] : [])] }
      }
      if (request.mode === "高清语音") await reply(context, $t("services.music.command.text_7e52f39cf7"))
      active.throwIfAborted()
      const { track, stream } = "episode" in source ? await api.playEpisode(source.episode, active)
        : { track: source.track, stream: await api.resolve(source.track, { exact: true, signal: active }) }
      const media = await api.prepareStream(track, stream, { signal: active })
      try { await sendVoice(context, media, active, true) }
      finally { await api.cleanup(media) }
      return []
    } catch (error) {
      if (!active.aborted) return request.mode + "：" + errorText(error)
    } finally {
      selected.busy = false
    }
  }

  async function showResults(context: Context, key: string, session: SearchSession) {
    session.loading = true
    const connection = context.message_type === "group" ? context.groupActivitySignal : context.privateCredentialSignal
    const active = AbortSignal.any([moduleSignal, session.controller.signal, ...(connection ? [connection] : [])])
    try {
      active.throwIfAborted()
      if (session.collection) {
        if (credentialScope(context) && context.user_id !== undefined) {
          await showCollection(context, key, session, session.collection, context.user_id, active)
        }
        return
      }
      const api = session.api
      if (!session.multiple && session.platform === "netease" && session.page === 1) {
        session.cloud = await cloud.search(context, api, session.keyword, active)
      }
      active.throwIfAborted()
      const limit = session.multiple ? multiplePageSize : api.config.search_limit
      const start = (session.page - 1) * limit
      const matching = session.cloud?.tracks ?? []
      const requestedCloud = matching.slice(start, start + limit)
      const offset = Math.max(0, start - matching.length)
      const remaining = limit - requestedCloud.length
      const search = !session.podcast && remaining > 0 ? await api.search(session.platform, session.keyword, session.page,
        { limit: remaining, offset, signal: active }) : undefined
      const episodes = session.podcast && remaining > 0 ? await api.searchEpisodes(session.keyword,
        { limit: remaining, offset, signal: active }) : []
      if (sessions.get(key) !== session || active.aborted) return
      const previous = session.multiple ? session.tracks ?? [] : []
      let tracks = [...requestedCloud.map(item => item.track), ...search?.tracks ?? []]
      if (!session.multiple && session.page > 1 && !tracks.length && !episodes.length) {
        await reply(context, session.tracks?.length || session.episodes?.length
          ? $t("services.music.command.text_055b27d80e") : $t("services.music.command.text_cbb229a60e"))
        session.page--
        return
      }
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
      const results: MusicMenuRow[] = [
        ...tracks.map((track, index) => {
          const cloud = index < requestedCloud.length
          const video = track.platform === "bilibili"
          const length = musicLength(video ? track.extensions?.video_duration_ms : track.duration_ms)
          return {
            number: previous.length + index + 1, name: track.name,
            artist: track.artists?.map(artist => artist.name).join(" / ") || (video ? $t("services.music.command.text_c96ed7ec0b") : $t("services.music.command.text_f374d78a34")),
            source: cloud ? $t("services.music.command.text_178f317ffa") : video ? $t("services.music.command.text_be20b1c3ef") : musicNames[track.platform],
            length: video && length ? $t("services.music.command.text_171c66846d") + length : length,
            ...(!cloud && { coverUrl: video ? track.extensions?.video_cover_url : track.album?.cover_url, coverPlatform: track.platform }),
          }
        }),
        ...episodes.map((episode, index) => ({ number: previous.length + tracks.length + index + 1, name: episode.name,
          artist: episode.creator || $t("services.music.command.text_bbae7d4a96"), source: $t("services.music.command.text_9b139653d2"), length: musicLength(episode.duration),
          coverUrl: episode.cover, coverPlatform: "netease" })),
      ]
      const choiceHint = session.multiple ? $t("services.music.command.text_17862e0d1b")
        : session.podcast ? $t("services.music.command.text_883fba2f6f")
        : session.platform === "bilibili" ? $t("services.music.command.text_3c49d447a3") :
        $t("services.music.command.text_ed10e665fa") + (search ? searchNotes[search.accountStatus] : "")
      const message = results.length ? choiceHint : session.multiple && previous.length
        ? session.exhausted ? $t("services.music.command.text_f770e3d8b7") : $t("services.music.command.text_f2ad3dc33a")
        : $t("services.music.command.text_1e262ef361")
      const title = session.multiple ? $t("services.music.command.text_512d2b9f5d", { "value1": musicNames[session.platform], "page": session.page })
        : session.podcast ? $t("services.music.command.text_9b139653d2") : musicNames[session.platform] + $t("services.music.command.text_a0c46fa3bd")
      const musicRows = await musicMenuCovers(results, active, fetchMusicCover)
      if (sessions.get(key) !== session || active.aborted) return
      const card = { title, subtitle: session.keyword, badge: $t("services.music.command.text_acac3da6c6", { "page": session.page }), message, musicRows }
      const limitBytes = context.inlineImageByteLimit ?? maxInlineBytes
      // The shared renderer already scales the requested 4× canvas for the low preset.
      const standard = nativeImageRasterScale() === 4
      const renderScale = standard ? Number(Bun.env.LOTUS_RENDER_SCALE ?? 4) : 4
      let image = await renderMusicMenu(card, { renderScale }).catch(() => undefined)
      if (image && image.length > limitBytes && standard && renderScale > 2 && !active.aborted) {
        image = await renderMusicMenu(card, { renderScale: 2 }).catch(() => undefined)
      }
      if (sessions.get(key) === session && !active.aborted) {
        if (requestedCloud.length && session.cloud) await cloud.assertVisible(context, api, session.cloud.binding, active)
        if (active.aborted || sessions.get(key) !== session) return
        const options = menuReplyOptions(key, session)
        await imageReply(context, image && image.length <= limitBytes ? image : undefined, [message, ...results.map(row =>
          row.number + ". " + [row.name, row.artist, row.source, row.length].filter(Boolean).join(" · "))].join("\n"), options, active)
      }
    } catch (error) {
      if (!active.aborted) throw error
    } finally {
      session.loading = false
    }
  }

  async function showCollection(context: Context, key: string, session: SearchSession, collection: MusicCollection, owner: number, active: AbortSignal) {
    const result = await readQqCollection(session.api, collection, owner, session.page, active)
    if (sessions.get(key) !== session || active.aborted) return
    session.tracks = result.tracks
    session.binding = result.binding
    session.expires = Date.now() + session.timeoutMs
    const title = collectionName[collection]
    const items = result.tracks.map((track, index) => ({ label: String(index + 1),
      value: `${track.name} · ${track.artists?.map(author => author.name).join(" / ") || $t("services.music.command.text_f374d78a34")}` }))
    const hint = items.length ? $t("services.music.command.text_7773b25735") + (collection === "favorites" && session.page > 0 ? $t("services.music.command.text_fa719e270d") : "") : $t("services.music.command.text_30bc9ab75f")
    const image = await renderStatusCard({ title, message: hint, items }).catch(() => undefined)
    if (active.aborted || sessions.get(key) !== session) return
    await verifyQqSelection(session.api, result.binding, active)
    if (!active.aborted && sessions.get(key) === session) {
      await imageReply(context, image, [title, hint, ...items.map(item => `${item.label}. ${item.value}`)].join("\n"), menuReplyOptions(key, session), active)
    }
  }

  async function handlePersonal(selection: NonNullable<ReturnType<typeof personalAction>>, context: Context, key: string) {
    if (context.isDelegated || context.message_type === "terminal") return
    const friend = credentialScope(context)
    if (selection.kind !== "recommend" && (!friend || context.user_id === undefined)) return $t("services.music.command.text_f74360072d")
    const connection = selection.kind === "recommend" ? context.groupActivitySignal ?? context.privateCredentialSignal : friend
    const active = connection ? AbortSignal.any([moduleSignal, connection]) : moduleSignal
    try {
      const { api, timeoutMs } = await openMusic()
      await recovery
      active.throwIfAborted()
      if (selection.kind === "recommend") {
        const track = await recommendQqSong(api, active)
        if (!track) return $t("services.music.command.text_dff639e0e9")
        remember(key, { track }, timeoutMs)
        const stream = await openPublicQqStream(api, track, active).catch(() => undefined)
        if (active.aborted) return []
        if (!stream) return $t("services.music.command.text_bcdc62151a", { "name": track.name, "value2": encodeURIComponent(track.id) })
        await playMedia(context, api, track, stream, active)
      } else if (selection.kind === "status") {
        const platforms = ["qq", "netease"] as const
        const statuses = await Promise.allSettled(platforms.map(platform => ownMusicStatus(api, platform, context.user_id!, active)))
        if (!active.aborted) return statuses.map((result, index) => `${musicNames[platforms[index]!]}：${result.status === "fulfilled" ? $t("services.music.command.text_6bab4dc3e5") : $t("services.music.command.text_ce48937714")}`).join("\n")
      } else if (selection.kind === "refresh") {
        if (activeLogins.has(selection.platform) || selection.platform === "netease" && (partnerJob || cloud.isUploading())) return $t("services.music.command.text_c32916b6f2")
        const status = await refreshOwnMusicAccount(api, selection.platform, context.user_id!, active)
        if (!active.aborted) return `${musicNames[selection.platform]}${status.extensions?.refreshed === false ? $t("services.music.command.text_a1c57f432a") : $t("services.music.command.text_b1bccd22bb")}`
      } else {
        const session: SearchSession = { stage: "search", api, controller: new AbortController(), platform: "qq", keyword: "", timeoutMs, podcast: false,
          page: selection.page, collection: selection.collection, expires: Date.now() + timeoutMs }
        replace(key, session)
        try { await showResults(context, key, session) }
        catch (error) { drop(key, session); throw error }
      }
    } catch (error) { if (!active.aborted) return errorText(error) }
    return []
  }

  async function partnerLoginDone(context: Context, active: AbortSignal, reused: boolean) {
    let done = reused ? $t("services.music.command.text_cbee02e3b0") : $t("services.music.command.text_e88cca0fe5")
    try {
      await enablePartnerAfterLogin(root, active, config => ownerPermission(context, config))
    } catch {
      if (active.aborted) return
      done = $t("services.music.command.text_51c6947c34")
    }
    const image = await renderStatusCard({ title: $t("services.music.command.text_10d2984e97"), subtitle: $t("services.music.command.text_54d3c7f785"), message: done }).catch(() => undefined)
    if (!active.aborted) await imageReply(context, image, done)
  }

  async function scan(context: Context, key: string, scanOptions: Scan, type?: string) {
    const friend = credentialScope(context)
    if (!friend) throw new Error($t("services.music.command.text_61a8ff5e8f"))
    const { platform, api } = scanOptions
    if (platform === "netease" && (partnerJob || cloud.isUploading())) throw new Error($t("services.music.command.text_e09e0b1a0c"))
    if (activeLogins.has(platform)) throw new Error($t("services.music.command.text_4c4c975027"))
    const timeoutMs = scanOptions.timeoutMs ?? musicLoginTimeout(platform)
    const controller = new AbortController()
    const session: ScanSession = { ...scanOptions, stage: "polling", controller, expires: Date.now() + timeoutMs }
    replace(key, session)
    activeLogins.set(platform, session)
    const active = AbortSignal.any([friend, moduleSignal, controller.signal])
    try {
      active.throwIfAborted()
      if (!scanOptions.force && context.user_id !== undefined && await api.reuseMusicLogin(platform, context.user_id, active, !session.partner)) {
        active.throwIfAborted()
        if (session.partner) await partnerLoginDone(context, active, true)
        else await reply(context, platform === "netease" ? $t("services.music.command.text_dcee797dc5")
          : $t("services.music.command.text_21251de44c", { "value1": musicNames[platform] }))
        return
      }
      if (session.partner) await api.tuneweave.requireReady("netease", active)
      const login = await api.createLogin(platform, context.user_id, type, { signal: active })
      active.throwIfAborted()
      const image = await renderTemplate("qr-login", { title: musicNames[platform] + $t("services.music.command.text_1e2df9c307"),
        subtitle: session.partner ? $t("services.music.command.text_54d3c7f785") : $t("services.music.command.text_d152e65e04"), badge: "SCAN",
        notice: $t("services.music.command.text_1ebdc04744"),
        qrDataUrl: login.image, profileId: platform,
      }).catch(() => undefined)
      active.throwIfAborted()
      if (!image) throw new Error($t("services.music.command.text_268dd48bf3"))
      let delivered = false
      await reply(context, { type: "image", file: image }, false, { onDelivered: () => { delivered = true } })
      if (!delivered) throw new Error($t("services.music.command.text_53be47adc3"))
      active.throwIfAborted()
      session.expires = Date.now() + timeoutMs
      await api.waitLogin(login, { signal: active, timeoutMs, pollMs: session.pollMs })
      if (active.aborted) return
      if (session.partner) await partnerLoginDone(context, active, false)
      else await reply(context, musicNames[platform] + $t("services.music.command.text_062565e39f"))
    } catch (error) {
      if (!active.aborted) throw error
    } finally {
      if (activeLogins.get(platform) === session) activeLogins.delete(platform)
      if (sessions.get(key) === session) sessions.delete(key)
    }
  }

  async function choose(message: string, context: Context, key: string) {
    let session = sessions.get(key)
    if (session?.stage === "search" && (session.multiple || session.collection) && context.isDelegated) return
    if (session && session.expires <= Date.now()) {
      drop(key, session)
      session = undefined
    }
    if (/^#(?:音乐)?取消$/u.test(message)) {
      const cancelPending = !context.isDelegated && pendingSearches.delete(key)
      if (session || cancelPending || (!context.isDelegated && selectionAt(key))) {
        if (session) drop(key, session)
        if (!context.isDelegated) forget(key)
        return $t("services.music.command.text_e51f42ed3c")
      }
      return
    }
    if (!session) return
    try {
      if (session.stage === "search") {
        const friend = session.collection ? credentialScope(context) : undefined
        if (session.collection && (!friend || friend.aborted)) return
        if (session.loading) return session.multiple ? $t("services.music.command.text_63b328a68c") : $t("services.music.command.text_c3c2f34d94")
        if (nextPage.test(message)) {
          if (session.collection && (session.collection !== "favorites" || session.page === 0)) return $t("services.music.command.text_6211a9bb16")
          if (session.multiple && session.exhausted) return $t("services.music.command.text_f770e3d8b7")
          retireMenu(session)
          const previous = { tracks: session.tracks, episodes: session.episodes, exhausted: session.exhausted, expires: session.expires }
          session.page++
          try { await showResults(context, key, session) }
          catch (error) {
            Object.assign(session, previous)
            session.page--
            throw error
          }
          return []
        }
        const index = Number(message.replace(/^#听/u, "")) - 1
        const trackCount = session.tracks?.length ?? 0
        const track = session.tracks?.[index]
        const episode = session.episodes?.[index - trackCount]
        if (!trackCount && !session.episodes?.length) return session.multiple ? $t("services.music.command.text_70bedb3f49") : $t("services.music.command.text_9c867c25eb")
        if (!track && !episode) return $t("services.music.command.text_50e029ca4e", { "value1": trackCount + (session.episodes?.length ?? 0) })
        if (session.collection && track && session.binding && friend) {
          drop(key, session)
          const active = AbortSignal.any([moduleSignal, friend])
          const { media, verifyDelivery } = await prepareOwnQqTrack(session.api, session.binding, track, active, async () => {
            active.throwIfAborted()
            await reply(context, $t("services.music.command.text_7f0fc7fa5b", { "name": track.name }))
          })
          await sendPreparedTrack(context, session.api, track, media, active, verifyDelivery)
          return []
        }
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
          await playSelection(context, key, { episode }, session.timeoutMs, async active => {
            const { track, stream } = await session.api.playEpisode(episode, active)
            await playMedia(context, session.api, track, stream, active)
          })
          return []
        }
        if (!track) return
        const cloudTrack = session.cloud?.tracks.find(item => item.track === track)
        if (cloudTrack && session.cloud) {
          forget(key)
          await cloud.play(context, session.api, session.cloud.binding, cloudTrack)
          return []
        }
        await playSelection(context, key, { track }, session.timeoutMs,
          active => playMedia(context, session.api, track, undefined, active))
      } else {
        if (!credentialScope(context)) throw new Error($t("services.music.command.text_61a8ff5e8f"))
        const index = Number(message) - 1
        if (session.stage === "platform") {
          const selected = session.platforms[index]
          if (!selected) throw new Error($t("services.music.command.text_8652f7450d"))
          const types = scanTypes[selected.platform]
          if (types) {
            sessions.set(key, { stage: "type", api: session.api, expires: session.expires, platform: selected.platform, types, force: session.force })
            return $t("services.music.command.text_d45c987145") + types.map((item, index) => `${index + 1}. ${item.name}`).join("\n")
          }
          await scan(context, key, { api: session.api, platform: selected.platform, force: session.force })
        } else if (session.stage === "type") {
          const type = session.types[index]
          if (!type) throw new Error($t("services.music.command.text_a3872c6038"))
          await scan(context, key, session, type.type)
        }
      }
    } catch (error) {
      if (!moduleSignal.aborted) return $t("services.music.command.text_50ceb8397d") + errorText(error)
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
      case "#音乐重新登录": return "login"
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
    const personal = personalAction(message)
    if (personal) return handlePersonal(personal, context, key)
    const followup = reissueTarget(message, context)
    const session = sessions.get(key)
    if (followup && !(session?.stage === "search" && session.collection)) return reissue(context, key, followup)
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
      const active = playbackSignal(context)
      try {
        const { api, defaultPlatform, timeoutMs } = await openMusic()
        await recovery
        active.throwIfAborted()
        const platform = legacy?.platform ?? defaultPlatform
        if (mode === "2") {
          if (platform !== "netease") return $t("services.music.command.text_aad65cd1db")
          const episode = await api.firstEpisode(keyword, active)
          if (!episode) return $t("services.music.command.text_a05fcf3c04")
          const source = episodeSelectionFromTrack(episode.track)
          if (source) await playSelection(context, key, { episode: source }, timeoutMs,
            playing => playMedia(context, api, episode.track, episode.stream, playing))
          else await playMedia(context, api, episode.track, episode.stream, active)
        } else {
          const variant = platform === "netease" ? "cloud" : undefined
          const { tracks: [track] } = await api.search(platform, keyword, 1, { limit: 1, variant, signal: active })
          if (!track) return $t("services.music.command.text_741a17100b")
          await playSelection(context, key, { track }, timeoutMs,
            playing => playMedia(context, api, track, undefined, playing))
        }
      } catch (error) {
        if (!active.aborted) return $t("services.music.command.text_d3a5a0bdfd") + errorText(error)
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
        if (podcast && platform !== "netease") return $t("services.music.command.text_aad65cd1db")
        const multipleTimeout = api.config.session_timeout_ms
        const sessionTimeout = multiple
          ? (multipleTimeout && multipleTimeout > 0 && multipleTimeout <= 2_147_483_647 ? multipleTimeout : defaultMultipleTimeoutMs)
          : timeoutMs
        const session: SearchSession = { stage: "search", api, controller: new AbortController(), platform, timeoutMs: sessionTimeout, keyword, podcast, page: 1,
          multiple, expires: Date.now() + sessionTimeout }
        replace(key, session)
        try { await showResults(context, key, session) }
        catch (error) {
          if (sessions.get(key) !== session) return []
          drop(key, session)
          throw error
        }
      } catch (error) {
        if (pendingSearches.get(key) === request) return $t("services.music.command.text_a4b2190ac0") + errorText(error)
      } finally {
        if (pendingSearches.get(key) === request) pendingSearches.delete(key)
      }
      return []
    }
    if (selected === "login") {
      if (!credentialScope(context)) return $t("services.music.command.text_61a8ff5e8f")
      try {
        const { api, timeoutMs } = await openMusic()
        const platforms = (await api.platforms()).filter(item => item.capabilities.includes("qr_login"))
        if (!platforms.length) throw new Error($t("services.music.command.text_20e967e6b6"))
        const force = message === "#音乐重新登录"
        replace(key, { stage: "platform", api, platforms, force, expires: Date.now() + timeoutMs })
        return $t("services.music.command.text_53fbbd0f86") + platforms.map((item, index) => `${index + 1}. ${item.name}`).join("\n") +
          $t("services.music.command.text_2362b9aa33")
      } catch (error) { return $t("services.music.command.text_50ceb8397d") + errorText(error) }
    }

    const config = await loadGlobalConfig()
    const owner = ownerPermission(context, config)
    if (selected === "partnerLogin") {
      if (!credentialScope(context) || !owner) return $t("services.music.command.text_b741c7c99f")
      const old = sessions.get(key)
      if (old) drop(key, old)
      const api = new MusicService({ tuneweaveConfig: config.tuneweave })
      const partner = config.netease_partner as PartnerConfig
      try {
        await scan(context, key, { api, platform: "netease", partner: true,
          timeoutMs: loginTime(partner.login_timeout_ms, musicLoginTimeout("netease")),
          pollMs: loginTime(partner.login_poll_ms, 3000) })
      } catch (error) { return $t("services.music.command.text_734a65411e") + errorText(error) }
      return []
    }
    if (selected === "partnerLog") {
      if (!credentialScope(context) || !owner) return $t("services.music.command.text_294976374e")
      let report
      try { report = await readPartnerLog() }
      catch { return $t("services.music.command.text_6ecadbcfa6") }
      if (report) return { type: "forward", nodes: partnerLogNodes(report) }
      const image = await renderStatusCard({ title: $t("services.music.command.text_6163e6ecdd"), subtitle: $t("services.music.command.text_0dff362ab0"), badge: $t("services.music.command.text_2f8267a89a"),
        message: $t("services.music.command.text_218220de0b", { "value1": formatLocalDateTime() }), items: [{ label: $t("services.music.command.text_10fafbeaa7"), value: $t("services.music.command.text_dcbf3a9edc") }],
      }).catch(() => undefined)
      await imageReply(context, image, $t("services.music.command.text_0c2899cd1a"))
      return []
    }
    if (selected === "partnerManual") {
      if (!owner) return $t("services.music.command.text_55235de83f")
      const request = context.privateCredentialSignal
      try {
        const report = await runPartnerTask(config, $t("services.music.command.text_f171cbec61"), {
          signal: request, before: () => reply(context, $t("services.music.command.text_17a8620052")),
        })
        if (request?.aborted || moduleSignal.aborted) return []
        if ("skipped" in report) return $t("services.music.command.text_21f81bcfa4")
        const card = await renderPartnerReport($t("services.music.command.text_ef7a54c064"), report, context.user_id)
        if (!request?.aborted) await imageReply(context, card.image, card.text)
      } catch {
        if (!request?.aborted && !moduleSignal.aborted) return $t("services.music.command.text_0b676b448a")
      }
      return []
    }
    if (selected === "initialize") {
      if (!owner) return $t("services.music.command.text_0359ccd99a")
      try {
        const result = await new TuneWeaveService({ config: config.tuneweave }).initialize({
          platform: "netease", onProgress: async (text: string) => { await reply(context, text) },
        })
        return $t("services.music.command.text_53522e23e5") + result.version + " · " + apiOrigin(result.apiUrl)
      } catch (error) { return $t("services.music.command.text_663c780296") + errorText(error) }
    }
    if (!owner) return $t("services.music.command.text_fe0190ecec")
    const status = await new TuneWeaveService({ config: config.tuneweave }).status("netease", moduleSignal)
    return "TuneWeave " + (status.requiresUpdate ? $t("services.music.command.text_f591f3067a") : status.ok ? $t("services.music.command.text_b073db9c0b") : $t("services.music.command.text_e5c84c9aa7")) +
      " · " + (status.version || $t("services.music.command.text_f1e7bec171")) + "\n" + apiOrigin(status.apiUrl) + "\n" + status.message
  }

  return {
    fallback,
    features(context: Context) {
      if (cloud.matches(context.normalizedMessage)) return featureNames
      if (personalAction(context.normalizedMessage)) return featureNames
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
