import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { hasNeteasePartnerAccount } from "../../../../lib/netease-partner-defaults.ts"
import { compatibleBilibiliDownload } from "../../../../lib/bilibili-download-compat.ts"
import { readOptionalConfigFile, readOptionalLocalConfig } from "../../../../lib/config.ts"
import { legacyLotusDirectories, readLotusGlobalConfig } from "../../../../lib/lotus-global-config.ts"

type Fields = Record<string, unknown>

function fields(value: unknown): Fields {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {}
}

function endpoint(value: unknown) {
  const address = fields(value).api_url
  return typeof address === "string" ? address : ""
}

const deployment = new URL("../../../../", import.meta.url)
const mediaSections = ["tools", "tuneweave", "bilibili", "douyin", "music", "netease_partner"]

export async function loadGlobalConfig(root = deployment) {
  const global = await readLotusGlobalConfig(root)
  const missing = mediaSections.filter(key => !Object.hasOwn(global, key))
  if (missing.length) {
    const histories = await Promise.all(legacyLotusDirectories.map(id => readOptionalLocalConfig(new URL(`plugins/${id}/`, root), "global")))
    for (const key of missing) {
      const values = histories.filter(config => config && Object.hasOwn(config, key)).map(config => config?.[key])
      if (!values.length) continue
      if (key === "tuneweave") {
        const configured = values.filter(value => endpoint(value))
        const endpoints = new Set(configured.map(value => endpoint(value).replace(/\/+$/, "")))
        if (endpoints.size > 1) throw new Error($t("core.config.global.text_667528e790"))
        global[key] = configured[0] ?? values[0]
      } else global[key] = values[0]
    }
  }
  const partner = fields(global.netease_partner)
  const partnerEnabled = typeof partner.enable === "boolean" ? partner.enable
    : await hasNeteasePartnerAccount(root)
  const permissions = fields(global.permissions)
  const scopes = fields(permissions.scopes)
  const bilibili = fields(global.bilibili)
  const download = compatibleBilibiliDownload(bilibili)
  return {
    tools: fields(global.tools),
    tuneweave: fields(global.tuneweave),
    bilibili: bilibili.download ? { ...bilibili, download } : download,
    douyin: { enable: true, request_timeout_ms: 15000, ...fields(global.douyin) },
    music: fields(global.music),
    netease_partner: { ...partner, enable: partnerEnabled } as Fields,
    permissions: {
      ...permissions,
      scopes: {
        "bilibili.download": { policy: "inherit" },
        "douyin.download": { policy: "inherit" },
        ...scopes,
        "bilibili.login": { policy: fields(scopes["bilibili.login"]).policy === "deny" ? "deny" : "master_only" },
        "tools.install": { policy: fields(scopes["tools.install"]).policy === "deny" ? "deny" : "master_only" },
      },
    },
  }
}

export const publicShareSiteNames = { acfun: "AcFun", weishi: $t("core.config.global.text_e7b7b38f38"), zuiyou: $t("core.config.global.text_ff74373e3f"), wxchannels: $t("core.config.global.text_e34ce28b5a"), xhs: $t("core.config.global.text_d26c6a08a5"), xhh: $t("core.config.global.text_2d9ed741c0") } as const
export type PublicShareSite = keyof typeof publicShareSiteNames
const legacyPublicShareSiteNames: Readonly<Record<PublicShareSite,string>> = {acfun:"Acfun",weishi:"微视",zuiyou:"最右",wxchannels:"视频号",xhs:"小红书",xhh:"小黑盒"}

export async function loadPublicShareConfig(site: PublicShareSite, root = deployment) {
  const global = await readLotusGlobalConfig(root)
  const config = fields(global[site])
  const enable = typeof config.enable === "boolean" ? config.enable : undefined
  const privatePreview = typeof config.private_preview === "boolean" ? config.private_preview : undefined
  const legacy = enable === undefined || privatePreview === undefined
    ? await readOptionalConfigFile(root, "plugins/rconsole-plugin/config/tools.yaml") ??
      await readOptionalConfigFile(root, "backup/plugins/rconsole-plugin/config/tools.yaml")
    : undefined
  const blocked = Array.isArray(legacy?.globalBlackList) && legacy.globalBlackList.includes(legacyPublicShareSiteNames[site])
  return { enable: enable ?? !blocked, privatePreview: privatePreview ?? (legacy?.privateResolve === true),
    permissions: global.permissions }
}

export function loadAcfunConfig(root = deployment) {
  return loadPublicShareConfig("acfun", root)
}
