import { Job } from "node-schedule"
import { sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { pathToFileURL } from "node:url"
import { isAlias, isMap, parseDocument } from "yaml"
import { lockFile } from "../../lib/file-lock.ts"
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "../../lib/lotus-global-config-write.ts"
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair, type Pair, type SourceEdit } from "../../lib/yaml-source-edits.ts"
import { loadGlobalConfig, loadPublicShareConfig, publicShareSiteNames, type PublicShareSite } from "./core/config/global.ts"
import { dataPath } from "./core/path.ts"
import { createSubscriptionConfig, numericId, type SubscriptionSettings } from "./services/subscriptions/config.ts"
import { createOfficialVideoSettings, officialVideoGames } from "./services/official-video/settings.ts"
import { createOfficialLinkSettings, officialLinkToggles, parseTrustedTelegramUsers, type OfficialLinkPatch } from "./services/official-links/settings.ts"
import { createPipixiaSettings, pipixiaFields, type PipixiaSettings } from "./services/pipixia/settings.ts"

import type { SubscriptionPlatform } from "./services/subscriptions/types.ts"

interface SettingsField {
  readonly key: string
  readonly setting: keyof SubscriptionSettings
  readonly label: string
  readonly options?: readonly string[]
  readonly tags?: true | "groupIds"
  readonly component?: "EasyCron"
  readonly min?: number
  readonly max?: number
  readonly help?: string
}

type FieldInput = string | number | string[]

interface GuobaContext<Result> {
  readonly Result: { ok(): Result; error(message: string, status: number): Result }
  readonly changedFields?: readonly string[]
}

const sharedFields: readonly SettingsField[] = [
  { key: "pushMsgMode", setting: "picture", label: "推送消息模式", options: ["文字模式", "图片模式"] },
  { key: "mergeTextPic", setting: "merge", label: "文字图片合并发送", options: ["分开发送", "合并发送"],
    help: "仅在文字模式下生效。" },
  { key: "forwardSendDynamic", setting: "mergeForward", label: "合并转发动态", options: ["关闭", "开启"],
    help: "同一会话本次待推送的图片总数或文字总长度超过阈值时使用合并转发。" },
  { key: "maxPicsForSingleMsg", setting: "forwardPictureThreshold", label: "图片总数阈值", max: 100 },
  { key: "maxTextLengthForSingleMsg", setting: "forwardTextThreshold", label: "文字总长度阈值", max: 50_000 },
  { key: "pushStatus", setting: "enable", label: "定时推送", options: ["关闭", "开启"],
    help: "关闭后停止继续发送。启用时若宿主未注册定时任务，需重启。主人仍可手动执行任务。" },
  { key: "checkDynamicCD", setting: "cron", label: "定时推送周期", component: "EasyCron",
    help: "支持五段或六段 Cron 表达式，按北京时间执行，重启后生效。" },
  { key: "pushTransmit", setting: "forwards", label: "推送转发动态", options: ["关闭", "开启"],
    help: "关闭后，此平台的所有订阅都跳过转发动态。" },
  { key: "dynamicTimeRange", setting: "horizon", label: "动态时间范围（秒）", min: 1, max: 259_200,
    help: "只推送此时间范围内发布的动态。" },
  { key: "getDataRandomDelay", setting: "delay", label: "抓取间隔上限（毫秒）", max: 60_000,
    help: "同一轮获取多个账号的动态时随机等待。微博分条发送也会留出间隔。设为 0 可关闭等待。" },
  { key: "whiteWordslist", setting: "whitelist", label: "白名单关键词", tags: true,
    help: "填入关键词后，只推送命中至少一个关键词的动态。" },
  { key: "banWords", setting: "blacklist", label: "屏蔽关键词", tags: true,
    help: "每行一个关键词。正文或标题包含关键词时跳过推送。" },
  { key: "pushPicCountLimit", setting: "pictureLimit", label: "单条动态配图上限", max: 12 },
  { key: "pushContentLenLimit", setting: "contentLimit", label: "正文字符上限", max: 8000,
    help: "设为 0 时隐藏正文。" },
  { key: "pushContentLineLimit", setting: "lineLimit", label: "正文行数上限", max: 500,
    help: "设为 0 时隐藏正文。" },
  { key: "isSplit", setting: "split", label: "分片截图模式", options: ["单张图卡", "分片截图"],
    help: "仅在图片模式下生效。开启后，较长的动态可分成多张图卡。" },
  { key: "splitHeight", setting: "splitHeight", label: "分片高度（像素）", min: 700, max: 20_000,
    help: "仅在分片截图模式下生效。" },
  { key: "noSplitHeight", setting: "noSplitHeight", label: "单张图卡正文高度（像素）", min: 700, max: 20_000,
    help: "仅在单张图卡模式下生效。" },
  { key: "boxGrid", setting: "grid", label: "九宫格样式", options: ["逐图排列", "宫格排列"],
    help: "仅在图片模式下生效。多张图片可放在同一行。" },
  { key: "pushTaskLog", setting: "log", label: "记录推送结果汇总", options: ["关闭", "开启"],
    help: "记录已确认、未确认和异常的发送数量。" },
]
const platforms: readonly { id: SubscriptionPlatform; label: string; fields: readonly SettingsField[] }[] = [
  { id: "bilibili", label: "B站", fields: [
    ...sharedFields,
    { key: "liveAtAll", setting: "liveAtAll", label: "直播动态@全体成员", options: ["关闭", "开启"],
      help: "仅在下方指定的群生效，机器人需有全员提醒权限。" },
    { key: "liveAtAllGroupList", setting: "liveGroups", label: "直播提醒群号", tags: "groupIds",
      help: "每项输入一个群号。留空时不会提醒全体成员。" },
    { key: "liveAtAllCD", setting: "liveCooldown", label: "@全体成员冷却时间（秒）", min: 60, max: 86_400,
      help: "每个群单独计算冷却时间，默认为 1800 秒。" },
    { key: "liveAtAllErrMsg", setting: "liveFailureNotice", label: "@全体成员失败时提示", options: ["关闭", "开启"],
      help: "网关明确拒绝提醒时给出提示，直播动态仍会发送。" },
    { key: "parseVideoLink", setting: "parseVideoLink", label: "视频链接解析", options: ["关闭", "开启"],
      help: "控制聊天中的视频链接、视频编号和短链自动解析。搜看和下载指令仍可使用。" },
    { key: "sharedBiliLogin", setting: "sharedBiliLogin", label: "视频与动态共用 B 站登录", options: ["关闭", "开启"],
      help: "开启后，动态可使用 TuneWeave 中已登录且支持动态读取的 B 站会话。" },
  ] },
  { id: "weibo", label: "微博", fields: [...sharedFields,
    { key: "parseWeiboLink", setting: "parseWeiboLink", label: "公开动态链接预览", options: ["关闭", "开启"],
      help: "自动预览聊天中分享的公开微博。站点要求登录时提示打开原文。" },
    { key: "parseWeiboPrivate", setting: "parseWeiboPrivate", label: "私聊预览公开微博", options: ["关闭", "开启"],
      help: "主开关开启后，允许在私聊自动预览。" },
  ] },
]

function fieldValue(field: SettingsField, settings: SubscriptionSettings) {
  const value = settings[field.setting]
  if (value instanceof Set) return [...value]
  return field.component === "EasyCron" || field.tags ? value : Number(value)
}

const officialVideoToggles = [
  ["forwardMsg", "合并转发"], ["cover", "使用封面原图"], ["bh3", "包含崩坏3"],
  ["by", "包含崩坏因缘精灵"], ["xbgd", "包含星布谷地"],
] as const
const officialVideoTags = [
  ["groups", "定时推送群", "每行填写一个群号。留空时只提供手动查询。"],
  ["group_config", "群聊屏蔽的游戏", "按「群号: gs, sr」填写。游戏代号为 gs、sr、zzz、bh3、by、xbgd。"],
] as const

const publicShareSites = Object.keys(publicShareSiteNames) as PublicShareSite[]
const publicShareToggles = [
  ["enable", "解析及播放", "允许从群聊中的公开分享显示作品信息，并响应显式播放指令。"],
  ["private_preview", "私聊自动预览", "关闭时仍可在私聊发送播放指令。"],
] as const

type SharePatch = Partial<Record<typeof publicShareToggles[number][0], boolean>>

function publicSharePatch(site: PublicShareSite, values: Readonly<Record<string, unknown>>, edited: ReadonlySet<string> | undefined) {
  const patch: SharePatch = {}
  for (const [key] of publicShareToggles) {
    const name = `${site}.${key}`
    if (!Object.hasOwn(values, name) || (edited && !edited.has(name))) continue
    if (typeof values[name] !== "boolean") return
    patch[key] = values[name]
  }
  return patch
}

async function savePublicShare(root: URL, site: PublicShareSite, patch: SharePatch) {
  await updateLotusGlobalConfig(root, {
    canWrite: () => true,
    prepare(text, local) {
      const state = local[site]
      if (state !== undefined && (!state || typeof state !== "object" || Array.isArray(state))) throw new GlobalConfigWriteError("config")
      const current = state as Record<string, unknown> | undefined
      const changes = Object.entries(patch).filter(([key, value]) => current?.[key] !== value)
      if (!changes.length) return { value: undefined }
      const document = parseDocument(text, { strict: true, merge: true, uniqueKeys: true, keepSourceTokens: true })
      if (document.errors.length || (document.contents && !isMap(document.contents))) throw new GlobalConfigWriteError("config")
      const map = document.contents ?? undefined
      const section = map?.get(site, true)
      const pairs: Pair[] = []
      const edits: SourceEdit[] = []
      for (const [key, value] of changes) {
        const old = isMap(section) ? section.get(key, true) : undefined
        const flow = String(value)
        if (old) edits.push(replaceSourceScalar(text, old, flow))
        else pairs.push({ key, flow, block: [`${key}: ${flow}`] })
      }
      if (pairs.length) {
        if (isAlias(section)) edits.push(sourceAliasOverrides(text, section, pairs))
        else if (isMap(section)) edits.push(insertSourcePairs(text, section, pairs))
        else if (section === undefined) edits.push(insertSourcePairs(text, map, [sourceMappingPair(site, patch)]))
        else throw new GlobalConfigWriteError("config")
      }
      const yaml = edits.sort((a, b) => b.start - a.start || b.end - a.end)
        .reduce((content, edit) => content.slice(0, edit.start) + edit.value + content.slice(edit.end), text)
      if (!isDeepStrictEqual(Bun.YAML.parse(yaml), { ...local, [site]: { ...current, ...patch } })) throw new GlobalConfigWriteError("config")
      return { yaml, value: undefined }
    },
  })
}

function officialVideoPatch(values: Readonly<Record<string, unknown>>, edited: ReadonlySet<string> | undefined) {
  const patch: Record<string, boolean | readonly string[]> = {}
  for (const [key] of officialVideoToggles) {
    const name = `officialVideo.${key}`
    if (!Object.hasOwn(values, name) || (edited && !edited.has(name))) continue
    if (typeof values[name] !== "boolean") return
    patch[key] = values[name]
  }
  for (const [key] of officialVideoTags) {
    const name = `officialVideo.${key}`
    if (!Object.hasOwn(values, name) || (edited && !edited.has(name))) continue
    const value = values[name]
    if (!Array.isArray(value) || value.length > 1000 || !value.every(row => typeof row === "string")) return
    if (key === "groups" ? !value.every(row => numericId(row)) : !value.every(row => {
      const [group, ...games] = row.split(/[:：,，\s]+/u).filter(Boolean)
      return numericId(group) && games.length && games.every(game => Object.hasOwn(officialVideoGames, game))
    })) return
    patch[key] = value
  }
  return patch
}

function submittedValue(field: SettingsField, value: unknown): FieldInput | undefined {
  if (field.tags) {
    if (!Array.isArray(value) || !value.every(word => typeof word === "string")) return
    const tags = value.map(word => word.trim()).filter(Boolean)
    if (field.tags !== "groupIds") return tags
    if (tags.every(numericId)) return [...new Set(tags)]
    return
  }
  if (field.component === "EasyCron") {
    if (typeof value !== "string" || value.length > 128) return
    const cron = value.trim()
    if (!/^[\w*,/?#-]+(?:[ \t]+[\w*,/?#-]+){4,5}$/u.test(cron)) return
    const job = new Job(() => {})
    try {
      if (job.schedule({ rule: cron, tz: "Asia/Shanghai" }) && !("isOneTimeJob" in job && job.isOneTimeJob)) return cron
    } finally {
      job.cancel()
    }
    return
  }
  const number = typeof value === "string" && value.trim() ? Number(value) : value
  if (typeof number === "number" && Number.isSafeInteger(number) && number >= (field.min ?? 0) && number <= (field.max ?? 1)) return number
}

function changed(field: SettingsField, value: FieldInput, settings: SubscriptionSettings) {
  const before = fieldValue(field, settings)
  if (field.tags && Array.isArray(before) && Array.isArray(value)) {
    return before.length !== value.length || before.some((word, index) => word !== value[index])
  }
  return before !== value
}

export function supportGuoba(directory = dataPath, officialVideo = createOfficialVideoSettings(directory),
  root = directory === dataPath ? new URL("../../", import.meta.url) : pathToFileURL(directory + sep),
  pipixia = createPipixiaSettings(directory), loadConfig = loadGlobalConfig) {
  const config = createSubscriptionConfig(directory, lockFile)
  const officialLinks = createOfficialLinkSettings(directory, root)
  return {
    pluginInfo: { name: "media", title: "媒体", isV3: true, isV2: false },
    configInfo: {
      schemas: [...platforms.flatMap(({ id, label: platform, fields }) => [
        { component: "SOFT_GROUP_BEGIN", label: `${platform}动态推送` },
        ...fields.map(({ key, label, options, min, max, help, component, tags }) => ({
          field: `${id}.${key}`,
          label: key === "pushMsgMode" ? platform + label : label,
          bottomHelpMessage: help,
          component: component ?? (options || tags ? "Select" : "InputNumber"),
          componentProps: tags ? { mode: "tags" } : options ? { options: options.map((label, value) => ({ label, value })) }
            : max !== undefined ? { min: min ?? 0, max, step: 1 } : undefined,
        })),
      ]),
      ...publicShareSites.flatMap(site => [
        { component: "SOFT_GROUP_BEGIN", label: site === "acfun" ? "AcFun 视频" : publicShareSiteNames[site] },
        ...publicShareToggles.map(([key, label, bottomHelpMessage]) => ({
          field: `${site}.${key}`,
          label: key === "enable" ? `${label} ${site === "acfun" ? "AcFun 视频" : publicShareSiteNames[site]}` : label,
          bottomHelpMessage, component: "Switch",
        })),
      ]),
      { component: "SOFT_GROUP_BEGIN", label: "米游社官号视频" },
      ...officialVideoToggles.map(([key, label]) => ({ field: `officialVideo.${key}`, label, component: "Switch" })),
      ...officialVideoTags.map(([key, label, bottomHelpMessage]) => ({ field: `officialVideo.${key}`, label, bottomHelpMessage,
        component: "Select", componentProps: { mode: "tags" } })),
      { component: "SOFT_GROUP_BEGIN", label: "皮皮虾" },
      ...pipixiaFields.map(([key, label]) => ({ field: `pipixia.${key}`, label, component: "Switch" })),
      { component: "SOFT_GROUP_BEGIN", label: "公开链接预览" },
      ...officialLinkToggles.map(([key, label]) => ({ field: `officialLinks.${key}`, label, component: "Switch" })),
      { field: "officialLinks.trustedTelegramUsers", label: "Telegram 信任 QQ", component: "Select",
        componentProps: { mode: "tags" }, bottomHelpMessage: "只有主人和信任 QQ 可以触发公开 Telegram 预览。留空将只允许主人。" }],
      async getConfigData() {
        const entries = await Promise.all(platforms.map(async ({ id, fields }) => {
          const settings = await config.settings(id)
          return [id, Object.fromEntries(fields.map(field => [field.key, fieldValue(field, settings)]))]
        }))
        const [videos, shareSettings, tools, officialLinkSettings] = await Promise.all([officialVideo.settings(), Promise.all(publicShareSites.map(async site => {
          const settings = await loadPublicShareConfig(site, root)
          return [site, { enable: settings.enable, private_preview: settings.privatePreview }]
        })), loadConfig().then(config => config.tools), officialLinks.settings()])
        return { ...Object.fromEntries(entries), ...Object.fromEntries(shareSettings), pipixia: await pipixia.settings(tools),
          officialLinks: officialLinkSettings, officialVideo: { forwardMsg: videos.forward, cover: videos.cover, ...videos.selected,
          groups: videos.groups.map(String), group_config: [...videos.muted].filter(([, games]) => games.size)
            .map(([group, games]) => `${group}: ${[...games].join(", ")}`) } }
      },
      async setConfigData<Result>(values: Readonly<Record<string, unknown>>, { Result, changedFields }: GuobaContext<Result>) {
        const edited = Array.isArray(changedFields) ? new Set(changedFields) : undefined
        const videoPatch = officialVideoPatch(values, edited)
        if (!videoPatch) return Result.error("请填写有效的米游社官号视频设置。", 422)
        const sharePatches = new Map<PublicShareSite, SharePatch>()
        for (const site of publicShareSites) {
          const patch = publicSharePatch(site, values, edited)
          if (!patch) return Result.error(`请填写有效的${publicShareSiteNames[site]}设置。`, 422)
          if (Object.keys(patch).length) sharePatches.set(site, patch)
        }
        const pipixiaPatch: Partial<PipixiaSettings> = {}
        for (const [key] of pipixiaFields) {
          const name = `pipixia.${key}`
          if (!Object.hasOwn(values, name) || (edited && !edited.has(name))) continue
          const value = values[name]
          if (typeof value !== "boolean") return Result.error("请填写有效的皮皮虾开关。", 422)
          pipixiaPatch[key] = value
        }
        const officialLinkPatch: OfficialLinkPatch = {}
        for (const [key] of officialLinkToggles) {
          const field = `officialLinks.${key}`
          if (!Object.hasOwn(values, field) || (edited && !edited.has(field))) continue
          const value = values[field]
          if (typeof value !== "boolean") return Result.error("请填写有效的公开链接预览设置。", 422)
          officialLinkPatch[key] = value
        }
        const trustedField = "officialLinks.trustedTelegramUsers"
        if (Object.hasOwn(values, trustedField) && (!edited || edited.has(trustedField))) {
          const users = parseTrustedTelegramUsers(values[trustedField])
          if (!users) return Result.error("请填写有效的 Telegram 信任 QQ。", 422)
          officialLinkPatch.trustedTelegramUsers = users
        }
        const changes = new Map<SubscriptionPlatform, { field: SettingsField; value: FieldInput }[]>()
        for (const { id, label, fields } of platforms) {
          const selected = []
          for (const field of fields) {
            const name = `${id}.${field.key}`
            if (!Object.hasOwn(values, name) || (edited && !edited.has(name))) continue
            const value = submittedValue(field, values[name])
            if (value === undefined) {
              return Result.error(`请填写有效的${label}动态推送设置。`, 422)
            }
            selected.push({ field, value })
          }
          if (selected.length) changes.set(id, selected)
        }
        for (const [id, selected] of changes) {
          await config.editSettings(id, (settings) => Object.fromEntries(selected
            .filter(({ field, value }) => changed(field, value, settings))
            .map(({ field, value }) => [field.key, value])))
        }
        if (Object.keys(videoPatch).length) await officialVideo.save(videoPatch)
        for (const [site, patch] of sharePatches) await savePublicShare(root, site, patch)
        if (Object.keys(pipixiaPatch).length) await pipixia.save(pipixiaPatch)
        if (Object.keys(officialLinkPatch).length) await officialLinks.save(officialLinkPatch)
        return Result.ok()
      },
    },
  }
}
