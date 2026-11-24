import { isChatFileName, maxChatFileBytes } from "../../../../lib/chat-files.ts"
import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { renderStatusCard } from "../../core/render/service.ts"
import { isCloudMediaUrl, matchCloudTracks, NeteaseCloudLibrary } from "./cloud-service.ts"
import type { MusicService } from "./service.ts"
import { musicSessionKey } from "./service.ts"
import { parseMusicShare } from "./share-link.ts"

type Context = MessageFallbackContext
type Binding = Awaited<ReturnType<NeteaseCloudLibrary["verify"]>>
type CloudTrack = Awaited<ReturnType<NeteaseCloudLibrary["list"]>>["tracks"][number]
type Prepared = Awaited<ReturnType<MusicService["prepareStream"]>>
type CloudAction =
  | { readonly kind: "list"; readonly keyword: string; readonly page: number }
  | { readonly kind: "play"; readonly index: number }
  | { readonly kind: "match"; readonly index?: number; readonly target?: string }
  | { readonly kind: "refresh" | "clear" | "upload" }

export const cloudHelp = "主人好友私聊可使用 #我的云盘 [关键词]、#云盘下一页、#听云盘 1、#云盘更新、#清除云盘缓存。上传请引用自己发送的音频文件后用 #上传云盘。使用 #云盘匹配 1 网易云歌曲链接 可关联当前列表中的云盘曲目与官方歌曲。"

export function cloudAction(message: string): CloudAction | undefined {
  const list = /^(?:#?我的云盘|#rnc|#云盘搜索)(?:\s+(.+))?$/iu.exec(message)
  if (list) {
    const input = list[1] ?? ""
    const page = /(?:^|\s+)第([1-9]\d{0,5})页$/u.exec(input)
    return { kind: "list", keyword: page ? input.slice(0, page.index) : input, page: Number(page?.[1] ?? 1) }
  }
  const play = /^#(?:听云盘|播放云盘)\s*([1-9]\d{0,5})$/u.exec(message)
  if (play) return { kind: "play", index: Number(play[1]) }
  if (/^#云盘匹配(?:\s|$)/u.test(message)) {
    const match = /^#云盘匹配\s+([1-9]\d{0,5})\s+(\S+)$/u.exec(message)
    return { kind: "match", ...(match && { index: Number(match[1]), target: match[2] }) }
  }
  if (/^#?(?:云盘更新|更新云盘)$/u.test(message)) return { kind: "refresh" }
  if (/^#?清除云盘缓存$/u.test(message)) return { kind: "clear" }
  if (/^(?:#?(?:上传云盘|上传网盘)|#rnu)$/iu.test(message)) return { kind: "upload" }
}

interface Browse {
  readonly binding: Binding
  readonly snapshot: Awaited<ReturnType<NeteaseCloudLibrary["list"]>>
  readonly tracks: readonly CloudTrack[]
  readonly keyword: string
  page: number
  expires: number
}

interface CloudCommandsOptions {
  signal: AbortSignal
  ownerSignal: (context: Context) => AbortSignal | undefined
  open: () => Promise<MusicService>
  sendVoice: (context: Context, media: Prepared, signal?: AbortSignal) => Promise<void>
  accountBusy?: () => boolean
  render?: typeof renderStatusCard
}

const pageSize = 10
const turnLength = 120_000
const diskSpace = (value: number) => `${(value / (1024 * 1024)).toFixed(1)} MiB`
const matchUsage = "请使用 #云盘匹配 本页序号 网易云单曲链接或歌曲编号。"

function matchTarget(value: string | undefined) {
  if (!value) return
  if (/^[1-9]\d{0,19}$/u.test(value)) return value
  const link = parseMusicShare(value)
  if (link?.platform === "netease" && link.kind === "track") return link.id
}
function inventory({ tracks, used, capacity }: Browse["snapshot"]) {
  const usage = used !== undefined && capacity !== undefined ? ` · ${diskSpace(used)} / ${diskSpace(capacity)}` : ""
  return `共 ${tracks.length} 首${usage}`
}

export function createCloudCommands({ signal, ownerSignal, open, sendVoice, accountBusy, render = renderStatusCard }: CloudCommandsOptions) {
  const library = new NeteaseCloudLibrary()
  const browsing = new Map<string, Browse>()
  const writing = new Set<string>()

  function matches(message: string) { return cloudAction(message) !== undefined || message === "#云盘下一页" || message === "#云盘上一页" }

  function privateScope(context: Context) {
    const friend = ownerSignal(context)
    const owner = context.user_id
    if (friend && !friend.aborted && typeof owner === "number" && Number.isSafeInteger(owner) && owner > 0) {
      return { owner, active: AbortSignal.any([signal, friend]) }
    }
  }

  async function search(context: Context, api: MusicService, keyword: string, querySignal: AbortSignal) {
    const scope = privateScope(context)
    if (!scope || accountBusy?.()) return
    const active = AbortSignal.any([scope.active, querySignal, AbortSignal.timeout(5000)])
    try {
      const binding = await library.verify(api, scope.owner, active)
      const { tracks } = await library.list(api, binding, active)
      const found = matchCloudTracks(tracks, keyword)
      if (found.length) return { binding, tracks: found }
    } catch { /* Catalog search remains available when the private library is unreachable. */ }
  }

  async function assertVisible(context: Context, api: MusicService, binding: Binding, querySignal: AbortSignal) {
    const scope = privateScope(context)
    if (!scope || scope.owner !== binding.owner) throw new Error("当前会话无法访问此网易云盘。")
    await library.assertCurrent(api, binding, AbortSignal.any([scope.active, querySignal]))
  }

  async function play(context: Context, api: MusicService, expected: Binding, selected: CloudTrack) {
    const scope = privateScope(context)
    if (!scope || scope.owner !== expected.owner || accountBusy?.()) throw new Error("当前会话无法访问此网易云盘。")
    const { active } = scope
    const binding = await library.verify(api, scope.owner, active)
    if (binding.key !== expected.key) throw new Error("网易云绑定已变更，请重新查询云盘。")
    const stream = await library.stream(api, binding, selected, active)
    const media = await api.prepareStream(selected.track, stream, { signal: active, allowMediaUrl: isCloudMediaUrl })
    try {
      await library.assertCurrent(api, binding, active)
      await sendVoice(context, media, active)
    } finally { await api.cleanup(media) }
  }

  async function show(context: Context, api: MusicService, browse: Browse, active: AbortSignal) {
    const start = (browse.page - 1) * pageSize
    const tracks = browse.tracks.slice(start, start + pageSize)
    const maxPage = Math.max(1, Math.ceil(browse.tracks.length / pageSize))
    if (browse.page < 1 || browse.page > maxPage) return `请选择 1–${maxPage} 页。`
    const details = inventory(browse.snapshot) + (browse.keyword ? ` · 匹配 ${browse.tracks.length} 首` : "")
    const notes = `第 ${browse.page}/${maxPage} 页。使用 #听云盘 1 播放本页第 1 首，或 #云盘下一页 翻页。`
    const items = tracks.map(({ track, matched_track_ref }, index) => ({ label: String(index + 1),
      value: `${track.name} · ${track.artists?.map(artist => artist.name).join(" / ") || "未知歌手"}` +
        (matched_track_ref && /^netease:[1-9]\d{0,21}$/u.test(matched_track_ref) ? " · 已匹配 " + matched_track_ref.slice("netease:".length) : "") }))
    const image = await render({ title: "网易云盘", subtitle: browse.keyword, message: `${details}\n${notes}`, items }).catch(() => undefined)
    await library.assertCurrent(api, browse.binding, active)
    if (!image || !await context.reply({ type: "image", file: image })) {
      active.throwIfAborted()
      return ["网易云盘", details, notes, ...items.map(item => `${item.label}. ${item.value}`)].join("\n")
    }
    return []
  }

  async function handle(message: string, context: Context) {
    const scope = privateScope(context)
    if (!scope) {
      return "请由机器人主人在已连接的好友私聊使用网易云盘。"
    }
    if (accountBusy?.()) return "网易云扫码正在进行，请在登录完成后再操作云盘。"
    const { owner, active } = scope
    const key = musicSessionKey(context)
    for (const [scope, browse] of browsing) if (browse.expires <= Date.now()) browsing.delete(scope)
    const action = cloudAction(message)
    const target = action?.kind === "match" ? matchTarget(action.target) : undefined
    if (action?.kind === "match" && (!action.index || !target)) return matchUsage
    try {
      const api = await open()
      const binding = await library.verify(api, owner, active)
      if (action?.kind === "clear") {
        library.clear(binding)
        browsing.delete(key)
        return "已清除当前网易云账号的本地云盘缓存。"
      }
      if (action?.kind === "refresh") {
        const snapshot = await library.list(api, binding, active, true)
        browsing.delete(key)
        return `网易云盘已刷新，${inventory(snapshot)}。`
      }
      if (action?.kind === "upload") {
        if (writing.has(binding.key)) return "当前网易云账号已有云盘操作，请稍候。"
        if (accountBusy?.()) return "网易云扫码正在进行，请在登录完成后再上传。"
        writing.add(binding.key)
        try {
          const quote = context.reply_id && context.lookupReply ? await context.lookupReply() : undefined
          active.throwIfAborted()
          const attachment = context.reply_id ? quote?.user_id === owner ? quote.attachment : undefined : context.attachment
          if (!attachment || context.canReadAttachments !== true || !isChatFileName(attachment.name)) return "请添加音频文件，或引用自己发送的音频文件后使用 #上传云盘。"
          if (attachment.size !== undefined && (attachment.size <= 0 || attachment.size > maxChatFileBytes)) return "请选择不超过 16 MiB 的音频附件。"
          const bytes = await attachment.read(active)
          active.throwIfAborted()
          if (!bytes || attachment.size !== undefined && bytes.byteLength !== attachment.size) return "音频附件无法读取，请重新发送。"
          try { await library.upload(api, binding, { name: attachment.name, bytes }, active) }
          finally { browsing.delete(key) }
          return "音频已存入当前网易云账号的云盘。"
        } finally { writing.delete(binding.key) }
      }
      if (action?.kind === "list") {
        const snapshot = await library.list(api, binding, active)
        const browse = { binding, snapshot, tracks: matchCloudTracks(snapshot.tracks, action.keyword), keyword: action.keyword,
          page: action.page, expires: Date.now() + turnLength }
        if (browse.page <= Math.max(1, Math.ceil(browse.tracks.length / pageSize))) browsing.set(key, browse)
        return await show(context, api, browse, active)
      }
      const browse = browsing.get(key)
      if (!browse || browse.binding.key !== binding.key) return "请先使用 #我的云盘 [关键词] 查看云盘曲目。"
      if (action?.kind === "play" || action?.kind === "match") {
        const index = action.index ?? 0
        const position = (browse.page - 1) * pageSize + index - 1
        const selected = browse.tracks[position]
        if (index < 1 || index > pageSize || !selected) return "请输入当前页内的曲目序号。"
        if (action.kind === "match") {
          if (!target) return matchUsage
          if (writing.has(binding.key) || accountBusy?.()) return "当前网易云账号已有云盘操作，请稍候。"
          writing.add(binding.key)
          try {
            const result = await library.match(api, binding, selected, target, active)
            return result.changed ? `云盘曲目已匹配《${result.name}》。` : `该云盘曲目已关联《${result.name}》。`
          } finally {
            writing.delete(binding.key)
            browsing.delete(key)
          }
        }
        await play(context, api, binding, selected)
        return []
      }
      const nextPage = browse.page + (message === "#云盘下一页" ? 1 : -1)
      if (nextPage < 1 || nextPage > Math.max(1, Math.ceil(browse.tracks.length / pageSize))) return "已经没有更多云盘曲目。"
      const next = { ...browse, page: nextPage, expires: Date.now() + turnLength }
      browsing.set(key, next)
      return await show(context, api, next, active)
    } catch (error) {
      if (!active.aborted) return error instanceof Error ? error.message : "网易云盘请求失败，请稍后重试。"
      return []
    }
  }

  return { matches, handle, search, play, assertVisible, isUploading: () => writing.size > 0 }
}
