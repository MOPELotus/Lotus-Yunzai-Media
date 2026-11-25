import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
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

export const cloudHelp = $t("services.music.cloud-command.text_0bfc154254")

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
const matchUsage = $t("services.music.cloud-command.text_ed4047347e")

function matchTarget(value: string | undefined) {
  if (!value) return
  if (/^[1-9]\d{0,19}$/u.test(value)) return value
  const link = parseMusicShare(value)
  if (link?.platform === "netease" && link.kind === "track") return link.id
}
function inventory({ tracks, used, capacity }: Browse["snapshot"]) {
  const usage = used !== undefined && capacity !== undefined ? ` · ${diskSpace(used)} / ${diskSpace(capacity)}` : ""
  return $t("services.music.cloud-command.text_79a09edff6", { "length": tracks.length, "usage": usage })
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
    if (!scope || scope.owner !== binding.owner) throw new Error($t("services.music.cloud-command.text_346e5b2fc8"))
    await library.assertCurrent(api, binding, AbortSignal.any([scope.active, querySignal]))
  }

  async function play(context: Context, api: MusicService, expected: Binding, selected: CloudTrack) {
    const scope = privateScope(context)
    if (!scope || scope.owner !== expected.owner || accountBusy?.()) throw new Error($t("services.music.cloud-command.text_346e5b2fc8"))
    const { active } = scope
    const binding = await library.verify(api, scope.owner, active)
    if (binding.key !== expected.key) throw new Error($t("services.music.cloud-command.text_5e5afccf99"))
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
    if (browse.page < 1 || browse.page > maxPage) return $t("services.music.cloud-command.text_2635a486db", { "maxPage": maxPage })
    const details = inventory(browse.snapshot) + (browse.keyword ? $t("services.music.cloud-command.text_493cf69b78", { "length": browse.tracks.length }) : "")
    const notes = $t("services.music.cloud-command.text_4949e16c4f", { "page": browse.page, "maxPage": maxPage })
    const items = tracks.map(({ track, matched_track_ref }, index) => ({ label: String(index + 1),
      value: `${track.name} · ${track.artists?.map(artist => artist.name).join(" / ") || $t("services.music.cloud-command.text_f374d78a34")}` +
        (matched_track_ref && /^netease:[1-9]\d{0,21}$/u.test(matched_track_ref) ? $t("services.music.cloud-command.text_6a380f1dec") + matched_track_ref.slice("netease:".length) : "") }))
    const image = await render({ title: $t("services.music.cloud-command.text_178f317ffa"), subtitle: browse.keyword, message: `${details}\n${notes}`, items }).catch(() => undefined)
    await library.assertCurrent(api, browse.binding, active)
    if (!image || !await context.reply({ type: "image", file: image })) {
      active.throwIfAborted()
      return [$t("services.music.cloud-command.text_178f317ffa"), details, notes, ...items.map(item => `${item.label}. ${item.value}`)].join("\n")
    }
    return []
  }

  async function handle(message: string, context: Context) {
    const scope = privateScope(context)
    if (!scope) {
      return $t("services.music.cloud-command.text_907b445e2b")
    }
    if (accountBusy?.()) return $t("services.music.cloud-command.text_e895daa11b")
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
        return $t("services.music.cloud-command.text_339eb933cb")
      }
      if (action?.kind === "refresh") {
        const snapshot = await library.list(api, binding, active, true)
        browsing.delete(key)
        return $t("services.music.cloud-command.text_0170e4feac", { "value1": inventory(snapshot) })
      }
      if (action?.kind === "upload") {
        if (writing.has(binding.key)) return $t("services.music.cloud-command.text_e7a4fbe594")
        if (accountBusy?.()) return $t("services.music.cloud-command.text_900b2c06f7")
        writing.add(binding.key)
        try {
          const quote = context.reply_id && context.lookupReply ? await context.lookupReply() : undefined
          active.throwIfAborted()
          const attachment = context.reply_id ? quote?.user_id === owner ? quote.attachment : undefined : context.attachment
          if (!attachment || context.canReadAttachments !== true || !isChatFileName(attachment.name)) return $t("services.music.cloud-command.text_66b67a936f")
          if (attachment.size !== undefined && (attachment.size <= 0 || attachment.size > maxChatFileBytes)) return $t("services.music.cloud-command.text_c5fe0c967f")
          const bytes = await attachment.read(active)
          active.throwIfAborted()
          if (!bytes || attachment.size !== undefined && bytes.byteLength !== attachment.size) return $t("services.music.cloud-command.text_bbca5763bb")
          try { await library.upload(api, binding, { name: attachment.name, bytes }, active) }
          finally { browsing.delete(key) }
          return $t("services.music.cloud-command.text_a95573208b")
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
      if (!browse || browse.binding.key !== binding.key) return $t("services.music.cloud-command.text_023e7026dd")
      if (action?.kind === "play" || action?.kind === "match") {
        const index = action.index ?? 0
        const position = (browse.page - 1) * pageSize + index - 1
        const selected = browse.tracks[position]
        if (index < 1 || index > pageSize || !selected) return $t("services.music.cloud-command.text_2277a2c63f")
        if (action.kind === "match") {
          if (!target) return matchUsage
          if (writing.has(binding.key) || accountBusy?.()) return $t("services.music.cloud-command.text_e7a4fbe594")
          writing.add(binding.key)
          try {
            const result = await library.match(api, binding, selected, target, active)
            return result.changed ? $t("services.music.cloud-command.text_9865b6a45f", { "name": result.name }) : $t("services.music.cloud-command.text_02648951c1", { "name": result.name })
          } finally {
            writing.delete(binding.key)
            browsing.delete(key)
          }
        }
        await play(context, api, binding, selected)
        return []
      }
      const nextPage = browse.page + (message === "#云盘下一页" ? 1 : -1)
      if (nextPage < 1 || nextPage > Math.max(1, Math.ceil(browse.tracks.length / pageSize))) return $t("services.music.cloud-command.text_38b6085c33")
      const next = { ...browse, page: nextPage, expires: Date.now() + turnLength }
      browsing.set(key, next)
      return await show(context, api, next, active)
    } catch (error) {
      if (!active.aborted) return error instanceof Error ? error.message : $t("services.music.cloud-command.text_f671445650")
      return []
    }
  }

  return { matches, handle, search, play, assertVisible, isUploading: () => writing.size > 0 }
}
