import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { Job } from "node-schedule"
import { sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isAlias, isMap, parseDocument } from "yaml"
import { lockFile } from "../../lib/file-lock.ts"
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "../../lib/lotus-global-config-write.ts"
import { insertSourcePairs, replaceSourceScalar, sourceAliasOverrides, sourceMappingPair, type Pair, type SourceEdit } from "../../lib/yaml-source-edits.ts"
import { loadGlobalConfig, loadPublicShareConfig, publicShareSiteNames, type PublicShareSite } from "./core/config/global.ts"
import { dataPath } from "./core/path.ts"
import { createSubscriptionConfig, numericId, type SubscriptionSettings } from "./services/subscriptions/config.ts"
import { createOfficialVideoSettings, officialVideoGames } from "./services/official-video/settings.ts"
import { loadBiliPgcSettings } from "./services/bilibili/pgc.ts"
import { biliPgcQualities } from "./services/bilibili/pgc-playback.ts"
import { createOfficialLinkSettings, officialLinkToggles, officialLinkTrustFields, parseTrustedOfficialLinkUsers, type OfficialLinkPatch } from "./services/official-links/settings.ts"
import { createSummaryModel, parseSummaryModelPatch } from "./services/official-links/summary-model.ts"
import { publicPageExclusions, readPublicPageExclusions, savePublicPageExclusions } from "./services/web-summary/public-page-settings.ts"
import { createJikeSettings, jikeFields } from "./services/jike/settings.ts"
import { createPublicShareSettings } from "./services/public-share/settings.ts"
import { xiguaFields } from "./services/xigua/preview.ts"
import { createKuaishouSettings, kuaishouFields } from "./services/kuaishou/settings.ts"
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
  { key: "pushMsgMode", setting: "picture", label: $t("guoba-settings.text_2f0382d71e"), options: [$t("guoba-settings.text_33b1fc99ac"), $t("guoba-settings.text_f84261b06f")] },
  { key: "mergeTextPic", setting: "merge", label: $t("guoba-settings.text_5db4f2266a"), options: [$t("guoba-settings.text_45a8421b35"), $t("guoba-settings.text_b6e0fc7fc1")],
    help: $t("guoba-settings.text_2812dae477") },
  { key: "forwardSendDynamic", setting: "mergeForward", label: $t("guoba-settings.text_05b78fdd0f"), options: [$t("guoba-settings.text_3fd47edce4"), $t("guoba-settings.text_8da97ddda9")],
    help: $t("guoba-settings.text_e7e53e6488") },
  { key: "maxPicsForSingleMsg", setting: "forwardPictureThreshold", label: $t("guoba-settings.text_8021c2a9c2"), max: 100 },
  { key: "maxTextLengthForSingleMsg", setting: "forwardTextThreshold", label: $t("guoba-settings.text_04e23da801"), max: 50_000 },
  { key: "pushStatus", setting: "enable", label: $t("guoba-settings.text_60947f0c24"), options: [$t("guoba-settings.text_3fd47edce4"), $t("guoba-settings.text_8da97ddda9")],
    help: $t("guoba-settings.text_02856d1f1d") },
  { key: "checkDynamicCD", setting: "cron", label: $t("guoba-settings.text_0526fa0ce0"), component: "EasyCron",
    help: $t("guoba-settings.text_8667e4aed1") },
  { key: "pushTransmit", setting: "forwards", label: $t("guoba-settings.text_b2ebb05417"), options: [$t("guoba-settings.text_3fd47edce4"), $t("guoba-settings.text_8da97ddda9")],
    help: $t("guoba-settings.text_2f808fffc7") },
  { key: "dynamicTimeRange", setting: "horizon", label: $t("guoba-settings.text_e32aa23ac7"), min: 1, max: 259_200,
    help: $t("guoba-settings.text_cb39b94fd1") },
  { key: "getDataRandomDelay", setting: "delay", label: $t("guoba-settings.text_b35306e1c6"), max: 60_000,
    help: $t("guoba-settings.text_2d92fff83b") },
  { key: "whiteWordslist", setting: "whitelist", label: $t("guoba-settings.text_5517f3fe91"), tags: true,
    help: $t("guoba-settings.text_c6145efdef") },
  { key: "banWords", setting: "blacklist", label: $t("guoba-settings.text_1d6c3a1841"), tags: true,
    help: $t("guoba-settings.text_fe5c7e2893") },
  { key: "pushPicCountLimit", setting: "pictureLimit", label: $t("guoba-settings.text_8d42b41b9c"), max: 12 },
  { key: "pushContentLenLimit", setting: "contentLimit", label: $t("guoba-settings.text_74690beb19"), max: 8000,
    help: $t("guoba-settings.text_b18efbbefc") },
  { key: "pushContentLineLimit", setting: "lineLimit", label: $t("guoba-settings.text_132c6935bf"), max: 500,
    help: $t("guoba-settings.text_b18efbbefc") },
  { key: "isSplit", setting: "split", label: $t("guoba-settings.text_5420d2fe8c"), options: [$t("guoba-settings.text_ece01bbfaa"), $t("guoba-settings.text_391de7a063")],
    help: $t("guoba-settings.text_fd1efb6bfb") },
  { key: "splitHeight", setting: "splitHeight", label: $t("guoba-settings.text_22b104cf6e"), min: 700, max: 20_000,
    help: $t("guoba-settings.text_455094f7cb") },
  { key: "noSplitHeight", setting: "noSplitHeight", label: $t("guoba-settings.text_f67e10c249"), min: 700, max: 20_000,
    help: $t("guoba-settings.text_3974ea0d10") },
  { key: "boxGrid", setting: "grid", label: $t("guoba-settings.text_e3a61badaa"), options: [$t("guoba-settings.text_ebeab3b65b"), $t("guoba-settings.text_669f8fbbdc")],
    help: $t("guoba-settings.text_39b6e2ffae") },
  { key: "pushTaskLog", setting: "log", label: $t("guoba-settings.text_2e0ab455aa"), options: [$t("guoba-settings.text_3fd47edce4"), $t("guoba-settings.text_8da97ddda9")],
    help: $t("guoba-settings.text_45ca7bb666") },
]
const platforms: readonly { id: SubscriptionPlatform; label: string; fields: readonly SettingsField[] }[] = [
  { id: "bilibili", label: $t("guoba-settings.text_acfb839ad1"), fields: [
    ...sharedFields,
    { key: "liveAtAll", setting: "liveAtAll", label: $t("guoba-settings.text_da1ef04e5a"), options: [$t("guoba-settings.text_3fd47edce4"), $t("guoba-settings.text_8da97ddda9")],
      help: $t("guoba-settings.text_2a265869e0") },
    { key: "liveAtAllGroupList", setting: "liveGroups", label: $t("guoba-settings.text_00d3776138"), tags: "groupIds",
      help: $t("guoba-settings.text_083e51f167") },
    { key: "liveAtAllCD", setting: "liveCooldown", label: $t("guoba-settings.text_c0c5dad971"), min: 60, max: 86_400,
      help: $t("guoba-settings.text_cd53a02ae1") },
    { key: "liveAtAllErrMsg", setting: "liveFailureNotice", label: $t("guoba-settings.text_adf84becdc"), options: [$t("guoba-settings.text_3fd47edce4"), $t("guoba-settings.text_8da97ddda9")],
      help: $t("guoba-settings.text_0323a1a892") },
    { key: "parseVideoLink", setting: "parseVideoLink", label: $t("guoba-settings.text_88fd352635"), options: [$t("guoba-settings.text_3fd47edce4"), $t("guoba-settings.text_8da97ddda9")],
      help: $t("guoba-settings.text_a49dcb75c4") },
    { key: "sharedBiliLogin", setting: "sharedBiliLogin", label: $t("guoba-settings.text_2e42c1f303"), options: [$t("guoba-settings.text_3fd47edce4"), $t("guoba-settings.text_8da97ddda9")],
      help: $t("guoba-settings.text_0c9d2dbdfc") },
  ] },
  { id: "weibo", label: $t("guoba-settings.text_0fc69798d8"), fields: [...sharedFields,
    { key: "parseWeiboLink", setting: "parseWeiboLink", label: $t("guoba-settings.text_7b89be2fdf"), options: [$t("guoba-settings.text_3fd47edce4"), $t("guoba-settings.text_8da97ddda9")],
      help: $t("guoba-settings.text_5385a0038b") },
    { key: "parseWeiboPrivate", setting: "parseWeiboPrivate", label: $t("guoba-settings.text_646c7a6881"), options: [$t("guoba-settings.text_3fd47edce4"), $t("guoba-settings.text_8da97ddda9")],
      help: $t("guoba-settings.text_3a73107b7a") },
    { key: "weiboComments", setting: "weiboComments", label: $t("guoba-settings.text_f5c51a4d82"), options: [$t("guoba-settings.text_3fd47edce4"), $t("guoba-settings.text_8da97ddda9")],
      help: $t("guoba-settings.text_b532f0c078") },
  ] },
]

function fieldValue(field: SettingsField, settings: SubscriptionSettings) {
  const value = settings[field.setting]
  if (value instanceof Set) return [...value]
  return field.component === "EasyCron" || field.tags ? value : Number(value)
}

const officialVideoToggles = [
  ["forwardMsg", $t("guoba-settings.text_5c8697bb9f")], ["cover", $t("guoba-settings.text_bd1f24e0d1")], ["bh3", $t("guoba-settings.text_9663fc5dbb")],
  ["by", $t("guoba-settings.text_555ceff239")], ["xbgd", $t("guoba-settings.text_98a8569cfe")],
] as const
const officialVideoTags = [
  ["groups", $t("guoba-settings.text_3d0ec334f0"), $t("guoba-settings.text_985e883d81")],
  ["group_config", $t("guoba-settings.text_fdbe9f4a67"), $t("guoba-settings.text_45054a1a4a")],
] as const

const publicShareSites = Object.keys(publicShareSiteNames) as PublicShareSite[]
const publicShareToggles = [
  ["enable", $t("guoba-settings.text_a491bc9f1a"), $t("guoba-settings.text_4d869b88ca")],
  ["private_preview", $t("guoba-settings.text_cf97f46a42"), $t("guoba-settings.text_0659cec525")],
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
  pipixia = createPipixiaSettings(directory), loadConfig = loadGlobalConfig, kuaishou = createKuaishouSettings(directory), jike = createJikeSettings(directory)) {
  const config = createSubscriptionConfig(directory, lockFile, root)
  const officialLinks = createOfficialLinkSettings(directory, root)
  const summary = createSummaryModel({ directory, root })
  const summaryFields = [
    { key: "summaryEnabled", label: $t("guoba-settings.text_0655e8e0c1"), component: "Switch",
      bottomHelpMessage: $t("guoba-settings.text_9773426ab2") },
    { key: "summaryMode", label: $t("guoba-settings.text_8a247b638a"), component: "Select",
      componentProps: { options: [{ label: $t("guoba-settings.text_73944a9c99"), value: "general" }, { label: $t("guoba-settings.text_bacdc0ead5"), value: "yuanbao" }] },
      bottomHelpMessage: $t("guoba-settings.text_2d38e23178") },
    { key: "summaryBaseUrl", label: $t("guoba-settings.text_9596563130"), component: "Input" },
    { key: "summaryModel", label: $t("guoba-settings.text_a966176ffc"), component: "Input" },
    { key: "summaryApiKey", label: $t("guoba-settings.text_3b7d1d8595"), component: "InputPassword" },
  ] as const
  const exclusionFields = [
    { key: "deny_hosts", label: $t("guoba-settings.text_ef36915efb"), bottomHelpMessage: $t("guoba-settings.text_f6858b96b6") },
    { key: "deny_networks", label: $t("guoba-settings.text_e32192bb5d"), bottomHelpMessage: $t("guoba-settings.text_71b746ee56") },
  ] as const
  const publicShares = [
    { id: "pipixia", name: $t("guoba-settings.text_13618d1860"), fields: pipixiaFields, store: pipixia },
    { id: "kuaishou", name: $t("guoba-settings.text_b210af9eae"), fields: kuaishouFields, store: kuaishou },
    { id: "jike", name: $t("guoba-settings.text_61528bef0f"), fields: jikeFields, store: jike },
    { id: "xigua", name: $t("guoba-settings.text_939dc2066a"), fields: xiguaFields, store: createPublicShareSettings("xigua", $t("guoba-settings.text_939dc2066a"), directory, fileURLToPath(root)) },
  ] as const
  return {
    pluginInfo: { name: "media", title: $t("guoba-settings.text_fa33e10009"), isV3: true, isV2: false },
    configInfo: {
      schemas: [...platforms.flatMap(({ id, label: platform, fields }) => [
        { component: "SOFT_GROUP_BEGIN", label: $t("guoba-settings.text_14970058c7", { "platform": platform }) },
        ...fields.map(({ key, label, options, min, max, help, component, tags }) => ({
          field: `${id}.${key}`,
          label: key === "pushMsgMode" ? platform + label : label,
          bottomHelpMessage: help,
          component: component ?? (options || tags ? "Select" : "InputNumber"),
          componentProps: tags ? { mode: "tags" } : options ? { options: options.map((label, value) => ({ label, value })) }
            : max !== undefined ? { min: min ?? 0, max, step: 1 } : undefined,
        })),
      ]),
      { component: "SOFT_GROUP_BEGIN", label: $t("guoba-settings.text_5914196fa3") },
      { field: "bilibili.biliPgcAuto", label: $t("guoba-settings.text_9901c582ed"), component: "Switch",
        bottomHelpMessage: $t("guoba-settings.text_4e486cabbb") },
      { field: "bilibili.biliPgcQuality", label: $t("guoba-settings.text_811bcd0212"), component: "Select",
        componentProps: { options: biliPgcQualities.map(([value, label]) => ({ label, value })) } },
      { field: "bilibili.biliPgcDuration", label: $t("guoba-settings.text_4062f32600"), component: "InputNumber",
        componentProps: { min: 1, max: 86_400, step: 1 } },
      ...publicShareSites.flatMap(site => [
        { component: "SOFT_GROUP_BEGIN", label: site === "acfun" ? $t("guoba-settings.text_712abaa5fb") : publicShareSiteNames[site] },
        ...publicShareToggles.map(([key, label, bottomHelpMessage]) => ({
          field: `${site}.${key}`,
          label: site === "wxchannels" && key === "enable" ? $t("guoba-settings.text_9e3955c093")
            : site === "xhs" ? (key === "enable" ? $t("guoba-settings.text_f39432053c") : $t("guoba-settings.text_5199b61553"))
            : site === "xhh" ? (key === "enable" ? $t("guoba-settings.text_26e475c3e8") : $t("guoba-settings.text_dfaab26f1d"))
            : key === "enable" ? `${label} ${site === "acfun" ? $t("guoba-settings.text_712abaa5fb") : publicShareSiteNames[site]}` : label,
          bottomHelpMessage: site === "wxchannels" ? (key === "enable"
            ? $t("guoba-settings.text_b5cdd4ef78") : $t("guoba-settings.text_52d4a75489"))
            : site === "xhs" ? (key === "enable" ? $t("guoba-settings.text_d46969a0af") : $t("guoba-settings.text_52d4a75489"))
            : site === "xhh" ? (key === "enable" ? $t("guoba-settings.text_1c21a93420") : $t("guoba-settings.text_52d4a75489"))
            : bottomHelpMessage, component: "Switch",
        })),
      ]),
      { component: "SOFT_GROUP_BEGIN", label: $t("guoba-settings.text_42cb32e402") },
      ...officialVideoToggles.map(([key, label]) => ({ field: `officialVideo.${key}`, label, component: "Switch" })),
      ...officialVideoTags.map(([key, label, bottomHelpMessage]) => ({ field: `officialVideo.${key}`, label, bottomHelpMessage,
        component: "Select", componentProps: { mode: "tags" } })),
      ...publicShares.flatMap(share => [
        { component: "SOFT_GROUP_BEGIN", label: share.name },
        ...share.fields.map(([key, label]) => ({ field: `${share.id}.${key}`, label, component: "Switch" })),
      ]),
      { component: "SOFT_GROUP_BEGIN", label: $t("guoba-settings.text_e6322d7411") },
      ...officialLinkToggles.map(([key, label]) => ({ field: `officialLinks.${key}`, label, component: "Switch" })),
      ...([[officialLinkTrustFields.telegram, "Telegram"], [officialLinkTrustFields.x, "X"]] as const).map(([key, label]) => ({
        field: `officialLinks.${key}`, label: $t("guoba-settings.text_5363847c40", { "label": label }), component: "Select",
        componentProps: { mode: "tags" }, bottomHelpMessage: $t("guoba-settings.text_ae6799f309")
      })),
      ...summaryFields.map(({ key, ...schema }) => ({ ...schema, field: `officialLinks.${key}` })),
      ...exclusionFields.map(({ key, ...schema }) => ({ ...schema, field: `web_summary.${key}`,
        component: "Select", componentProps: { mode: "tags" } }))],
      async getConfigData() {
        const entries = await Promise.all(platforms.map(async ({ id, fields }) => {
          const settings = await config.settings(id)
          const values = Object.fromEntries(fields.map(field => [field.key, fieldValue(field, settings)]))
          if (id === "bilibili") {
            const pgc = await loadBiliPgcSettings(root, async () => settings)
            Object.assign(values, { biliPgcAuto: pgc.automatic, biliPgcQuality: pgc.quality, biliPgcDuration: pgc.duration })
          }
          return [id, values]
        }))
        const [videos, shareSettings, tools, officialLinkSettings, summarySettings, webSummaryExclusions] = await Promise.all([officialVideo.settings(), Promise.all(publicShareSites.map(async site => {
          const settings = await loadPublicShareConfig(site, root)
          return [site, { enable: settings.enable, private_preview: settings.privatePreview }]
        })), loadConfig().then(config => config.tools), officialLinks.settings(), summary.settings(), readPublicPageExclusions(root)])
        const { summaryApiKeyConfigured, ...summaryInput } = summarySettings
        const shares = await Promise.all(publicShares.map(async share => [share.id, await share.store.settings(tools)]))
        return { ...Object.fromEntries([...entries, ...shareSettings, ...shares]),
          officialLinks: { ...officialLinkSettings, ...summaryInput, ...(summaryApiKeyConfigured && { summaryApiKey: "configured" }) },
          ...(webSummaryExclusions && { web_summary: webSummaryExclusions }),
          officialVideo: { forwardMsg: videos.forward, cover: videos.cover, ...videos.selected,
          groups: videos.groups.map(String), group_config: [...videos.muted].filter(([, games]) => games.size)
            .map(([group, games]) => `${group}: ${[...games].join(", ")}`) } }
      },
      async setConfigData<Result>(values: Readonly<Record<string, unknown>>, { Result, changedFields }: GuobaContext<Result>) {
        const edited = Array.isArray(changedFields) ? new Set(changedFields) : undefined
        const videoPatch = officialVideoPatch(values, edited)
        if (!videoPatch) return Result.error($t("guoba-settings.text_fc9e127d73"), 422)
        const sharePatches = new Map<PublicShareSite, SharePatch>()
        for (const site of publicShareSites) {
          const patch = publicSharePatch(site, values, edited)
          if (!patch) return Result.error($t("guoba-settings.text_6949b04c81", { "value1": publicShareSiteNames[site] }), 422)
          if (Object.keys(patch).length) sharePatches.set(site, patch)
        }
        const publicSharePatches = new Map<typeof publicShares[number]["store"], Partial<PipixiaSettings>>()
        for (const share of publicShares) {
          const patch: Partial<PipixiaSettings> = {}
          for (const [key] of share.fields) {
            const name = `${share.id}.${key}`
            if (!Object.hasOwn(values, name) || (edited && !edited.has(name))) continue
            const value = values[name]
            if (typeof value !== "boolean") return Result.error($t("guoba-settings.text_e11f1b2549", { "name": share.name }), 422)
            patch[key] = value
          }
          if (Object.keys(patch).length) publicSharePatches.set(share.store, patch)
        }
        const officialLinkPatch: OfficialLinkPatch = {}
        for (const [key] of officialLinkToggles) {
          const field = `officialLinks.${key}`
          if (!Object.hasOwn(values, field) || (edited && !edited.has(field))) continue
          const value = values[field]
          if (typeof value !== "boolean") return Result.error($t("guoba-settings.text_2c80b0fd14"), 422)
          officialLinkPatch[key] = value
        }
        for (const key of Object.values(officialLinkTrustFields)) {
          const field = `officialLinks.${key}`
          if (!Object.hasOwn(values, field) || (edited && !edited.has(field))) continue
          const users = parseTrustedOfficialLinkUsers(values[field])
          if (!users) return Result.error($t("guoba-settings.text_aa4c41e7a4"), 422)
          officialLinkPatch[key] = users
        }
        const summaryPatch = parseSummaryModelPatch(Object.fromEntries(summaryFields.flatMap(({ key }) => {
          const field = `officialLinks.${key}`
          return Object.hasOwn(values, field) && (!edited || edited.has(field)) ? [[key, values[field]]] : []
        })))
        if (!summaryPatch) return Result.error($t("guoba-settings.text_8693a6e974"), 422)
        const exclusionPatch: Partial<Record<keyof typeof publicPageExclusions, string[]>> = {}
        for (const { key, label } of exclusionFields) {
          const field = `web_summary.${key}`
          if (!Object.hasOwn(values, field) || (edited && !edited.has(field))) continue
          const entries = publicPageExclusions[key](values[field])
          if (!entries) return Result.error($t("guoba-settings.text_3d26426d12", { "label": label }), 422)
          exclusionPatch[key] = entries
        }
        const pgcPatch: Record<string, boolean | number> = {}
        for (const key of ["biliPgcAuto", "biliPgcQuality", "biliPgcDuration"] as const) {
          const field = `bilibili.${key}`
          if (!Object.hasOwn(values, field) || (edited && !edited.has(field))) continue
          const value = values[field]
          const valid = key === "biliPgcAuto" ? typeof value === "boolean"
            : typeof value === "number" && Number.isSafeInteger(value) &&
              (key === "biliPgcQuality" ? biliPgcQualities.some(([quality]) => quality === value) : value >= 1 && value <= 86_400)
          if (!valid) return Result.error($t("guoba-settings.text_c7ccb96332"), 422)
          pgcPatch[key] = value as number | boolean
        }
        const changes = new Map<SubscriptionPlatform, { field: SettingsField; value: FieldInput }[]>()
        for (const { id, label, fields } of platforms) {
          const selected = []
          for (const field of fields) {
            const name = `${id}.${field.key}`
            if (!Object.hasOwn(values, name) || (edited && !edited.has(name))) continue
            const value = submittedValue(field, values[name])
            if (value === undefined) {
              return Result.error($t("guoba-settings.text_cd7091728d", { "label": label }), 422)
            }
            selected.push({ field, value })
          }
          if (selected.length) changes.set(id, selected)
        }
        if (Object.keys(exclusionPatch).length) await savePublicPageExclusions(root, exclusionPatch)
        for (const [id, selected] of changes) {
          await config.editSettings(id, (settings) => Object.fromEntries(selected
            .filter(({ field, value }) => changed(field, value, settings))
            .map(({ field, value }) => [field.key, value])))
        }
        if (Object.keys(pgcPatch).length) await config.editSettings("bilibili", () => pgcPatch)
        if (Object.keys(videoPatch).length) await officialVideo.save(videoPatch)
        for (const [site, patch] of sharePatches) await savePublicShare(root, site, patch)
        for (const [store, patch] of publicSharePatches) await store.save(patch)
        if (Object.keys(officialLinkPatch).length || Object.keys(summaryPatch).length) {
          await officialLinks.save({ ...officialLinkPatch, ...summaryPatch })
        }
        return Result.ok()
      },
    },
  }
}
