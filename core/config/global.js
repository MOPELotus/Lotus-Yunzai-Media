import { readLocalConfig } from "../../../../lib/config.ts"

const root = new URL("../../../../", import.meta.url)

export async function loadGlobalConfig() {
  const global = await readLocalConfig(root, "global")
  const permissions = global.permissions || {}
  return {
    tools: global.tools || {},
    tuneweave: global.tuneweave || {},
    bilibili: global.bilibili || {},
    douyin: { enable: true, request_timeout_ms: 15000, ...global.douyin },
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
