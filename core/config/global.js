import { readOptionalLocalConfig } from "../../../../lib/config.ts"
import { legacyLotusDirectories, readLotusGlobalConfig } from "../../../../lib/lotus-global-config.ts"

const deployment = new URL("../../../../", import.meta.url)
const mediaSections = ["tools", "tuneweave", "bilibili", "douyin", "music", "netease_partner"]

export async function loadGlobalConfig(root = deployment) {
  const global = await readLotusGlobalConfig(root)
  const missing = mediaSections.filter(key => !Object.hasOwn(global, key))
  if (missing.length) {
    const histories = await Promise.all(legacyLotusDirectories.map(id => readOptionalLocalConfig(new URL(`plugins/${id}/`, root), "global")))
    for (const key of missing) {
      const values = histories.filter(config => config && Object.hasOwn(config, key)).map(config => config[key])
      if (!values.length) continue
      if (key === "tuneweave") {
        const configured = values.filter(value => typeof value?.api_url === "string" && value.api_url)
        const endpoints = new Set(configured.map(value => value.api_url.replace(/\/+$/, "")))
        if (endpoints.size > 1) throw new Error("两处旧 TuneWeave 服务地址不一致，请在现用媒体配置中指定地址。")
        global[key] = configured[0] ?? values[0]
      } else global[key] = values[0]
    }
  }
  const permissions = global.permissions || {}
  return {
    tools: global.tools || {},
    tuneweave: global.tuneweave || {},
    bilibili: global.bilibili || {},
    douyin: { enable: true, request_timeout_ms: 15000, ...global.douyin },
    music: global.music || {},
    netease_partner: global.netease_partner || {},
    permissions: {
      ...permissions,
      scopes: {
        "bilibili.download": { policy: "inherit" },
        "douyin.download": { policy: "inherit" },
        ...permissions.scopes,
        "bilibili.login": { policy: permissions.scopes?.["bilibili.login"]?.policy === "deny" ? "deny" : "master_only" },
        "tools.install": { policy: permissions.scopes?.["tools.install"]?.policy === "deny" ? "deny" : "master_only" },
      },
    },
  }
}
