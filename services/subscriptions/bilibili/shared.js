import { loadGlobalConfig } from "../../../core/config/global.js"
import { BilibiliService } from "../../bilibili/service.js"

const capability = "bilibili_space_feed"
const platform = "bilibili"
const accountId = /^[1-9]\d{0,19}$/u
const fallbackErrors = new Set(["capability_not_supported", "authentication_required", "tuneweave_unavailable", "HTTP 404", "HTTP 502", "HTTP 503", "HTTP 504"])

export function biliSharedSession({ enabled = async () => true, createService = async () => {
  const { tuneweave } = await loadGlobalConfig()
  return new BilibiliService({ tuneweaveConfig: tuneweave })
} } = {}) {
  let known

  async function capable(service, signal) {
    signal?.throwIfAborted()
    const endpoint = service.tuneweave.config.api_url
    if (known?.endpoint === endpoint && Date.now() < known.until) return known.supported
    try {
      const timeout = AbortSignal.timeout(5000)
      const probe = signal ? AbortSignal.any([timeout, signal]) : timeout
      const registry = await service.tuneweave.request("/v1/capabilities?platform=bilibili", { signal: probe, redirect: "error" })
      const supported = Array.isArray(registry) && registry.some(entry => entry?.platform === platform &&
        entry.registered === true && Array.isArray(entry.capabilities) && entry.capabilities.includes(capability))
      known = { endpoint, supported, until: Date.now() + 60_000 }
      return supported
    } catch {
      signal?.throwIfAborted()
      known = { endpoint, supported: false, until: Date.now() + 30_000 }
      return false
    }
  }

  async function select(signal, needAccount) {
    signal?.throwIfAborted()
    if (!await enabled()) return
    let service, alias
    try {
      service = await createService()
      alias = (await service.loadAccount())?.tuneweave_account
    } catch {
      signal?.throwIfAborted()
      return
    }
    if ((needAccount && !alias) || !await capable(service, signal)) return
    return { service, alias }
  }

  return {
    async available(signal) { return Boolean(await select(signal, false)) },
    async status(signal) {
      const selected = await select(signal, false)
      if (!selected) return "unavailable"
      const { service, alias } = selected
      if (!alias) return "absent"
      try {
        const { data, accountSelected } = await service.tuneweave.request(
          "/v1/auth/session?" + new URLSearchParams({ platform, account: alias }), {
            signal, redirect: "error", accountSelection: { platform, alias },
          })
        signal?.throwIfAborted()
        if (!accountSelected || data?.platform !== platform || data?.account !== alias) return "unknown"
        if (data.authenticated === false) return "expired"
        return data.authenticated === true && typeof data.user_id === "string" && accountId.test(data.user_id) ? "active" : "unknown"
      } catch (error) {
        signal?.throwIfAborted()
        return error.code === "authentication_required" ? "expired" : "unknown"
      }
    },
    async fetchPosts(uid, signal) {
      if (!accountId.test(uid)) return
      const selected = await select(signal, true)
      if (!selected) return
      const { service, alias } = selected
      let response
      try {
        response = await service.tuneweave.request(
          "/v1/bilibili/users/" + uid + "/dynamics?" + new URLSearchParams({ account: alias }), {
            signal, redirect: "error", accountSelection: { platform, alias },
          })
      } catch (error) {
        signal?.throwIfAborted()
        if (fallbackErrors.has(error.code)) return
        throw error
      }
      signal?.throwIfAborted()
      const { data, accountSelected } = response
      if (!accountSelected || data?.authenticated !== true || !Array.isArray(data.items)) {
        throw new Error("TuneWeave 未确认当前 B 站共享会话。")
      }
      if (!await enabled() || (await service.loadAccount())?.tuneweave_account !== alias) {
        throw new Error("B 站共享会话配置已变更，请稍后重试。")
      }
      return data
    },
  }
}
