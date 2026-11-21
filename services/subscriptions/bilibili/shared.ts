import { loadGlobalConfig } from "../../../core/config/global.ts"
import { BilibiliService } from "../../bilibili/service.ts"

const capability = "bilibili_space_feed"
const platform = "bilibili"
const accountId = /^[1-9]\d{0,19}$/u
const fallbackErrors = new Set(["capability_not_supported", "authentication_required", "tuneweave_unavailable", "HTTP 404", "HTTP 502", "HTTP 503", "HTTP 504"])

interface SharedRequestOptions {
  method?: string
  body?: { platform: string; account: string; credential_mode: string }
  signal?: AbortSignal
  redirect: "error"
  accountSelection?: { platform: string; alias: string }
}

interface SharedAccountService {
  loadAccount(): Promise<{ tuneweave_account?: string | null } | undefined | null>
  tuneweave: {
    config: { api_url: string }
    request(route: string, options: SharedRequestOptions): Promise<unknown>
  }
}

interface SharedAccountProfile {
  platform?: unknown
  account?: unknown
  authenticated?: unknown
  user_id?: unknown
  items?: unknown[]
}

interface SharedAccountResponse {
  data?: SharedAccountProfile
  accountSelected?: unknown
}

interface SharedSessionOptions {
  enabled?: () => boolean | Promise<boolean>
  createService?: () => Promise<SharedAccountService>
}

type SharedStatus = "unavailable" | "absent" | "unknown" | "expired" | "active"

export interface BiliSharedSession {
  available(signal?: AbortSignal): Promise<boolean>
  status(signal?: AbortSignal): Promise<SharedStatus>
  fetchPosts(uid: string, signal?: AbortSignal): Promise<{ items: unknown[] } | undefined>
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined
}

function authenticated(profile: SharedAccountProfile | undefined, alias: string) {
  return profile?.platform === platform && profile.account === alias && profile.authenticated === true &&
    typeof profile.user_id === "string" && accountId.test(profile.user_id)
}

export function biliSharedSession({ enabled = async () => true, createService = async () => {
  const { tuneweave } = await loadGlobalConfig()
  return new BilibiliService({ tuneweaveConfig: tuneweave })
} }: SharedSessionOptions = {}): BiliSharedSession {
  let known: { endpoint: string; supported: boolean; until: number } | undefined
  let latestRefresh: { endpoint: string; alias: string; until: number } | undefined

  async function capable(service: SharedAccountService, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const endpoint = service.tuneweave.config.api_url
    if (known?.endpoint === endpoint && Date.now() < known.until) return known.supported
    try {
      const timeout = AbortSignal.timeout(5000)
      const probe = signal ? AbortSignal.any([timeout, signal]) : timeout
      const registry = await service.tuneweave.request("/v1/capabilities?platform=bilibili", { signal: probe, redirect: "error" })
      const supported = Array.isArray(registry) && registry.some((entry: { platform?: unknown; registered?: unknown; capabilities?: unknown } | undefined) => entry?.platform === platform &&
        entry.registered === true && Array.isArray(entry.capabilities) && entry.capabilities.includes(capability))
      known = { endpoint, supported, until: Date.now() + 60_000 }
      return supported
    } catch {
      signal?.throwIfAborted()
      known = { endpoint, supported: false, until: Date.now() + 30_000 }
      return false
    }
  }

  async function select(signal: AbortSignal | undefined, needAccount: boolean) {
    signal?.throwIfAborted()
    if (!await enabled()) return
    let service: SharedAccountService
    let alias: string | undefined
    try {
      service = await createService()
      alias = (await service.loadAccount())?.tuneweave_account ?? undefined
    } catch {
      signal?.throwIfAborted()
      return
    }
    if ((needAccount && !alias) || !await capable(service, signal)) return
    return { service, alias }
  }

  async function ensureCurrent(service: SharedAccountService, alias: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (!await enabled() || (await service.loadAccount())?.tuneweave_account !== alias) {
      throw new Error("B 站共享会话配置已变更，请稍后重试。")
    }
    signal?.throwIfAborted()
  }

  async function refresh(service: SharedAccountService, alias: string, signal?: AbortSignal) {
    await ensureCurrent(service, alias, signal)
    const endpoint = service.tuneweave.config.api_url
    if (latestRefresh?.endpoint === endpoint && latestRefresh.alias === alias && Date.now() < latestRefresh.until) return false
    latestRefresh = { endpoint, alias, until: Date.now() + 60_000 }
    const response = await service.tuneweave.request("/v1/auth/session/refresh", {
      method: "POST", body: { platform, account: alias, credential_mode: "server" },
      signal, redirect: "error", accountSelection: { platform, alias },
    })
    await ensureCurrent(service, alias, signal)
    const { data, accountSelected } = response as SharedAccountResponse
    if (!accountSelected || data?.platform !== platform || data?.account !== alias) {
      throw new Error("TuneWeave 未确认 B 站共享会话的刷新结果。")
    }
    return authenticated(data, alias)
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
          }) as SharedAccountResponse
        signal?.throwIfAborted()
        if (!accountSelected || data?.platform !== platform || data?.account !== alias) return "unknown"
        if (data.authenticated === false) return "expired"
        return authenticated(data, alias) ? "active" : "unknown"
      } catch (error) {
        signal?.throwIfAborted()
        return errorCode(error) === "authentication_required" ? "expired" : "unknown"
      }
    },
    async fetchPosts(uid, signal) {
      if (!accountId.test(uid)) return
      const selected = await select(signal, true)
      if (!selected?.alias) return
      const { service, alias } = selected
      const read = () => service.tuneweave.request(
        "/v1/bilibili/users/" + uid + "/dynamics?" + new URLSearchParams({ account: alias }), {
          signal, redirect: "error", accountSelection: { platform, alias },
        })
      let response
      try {
        try {
          response = await read()
        } catch (error) {
          if (errorCode(error) !== "authentication_required") throw error
          if (!await refresh(service, alias, signal)) return
          response = await read()
        }
      } catch (error) {
        signal?.throwIfAborted()
        const code = errorCode(error)
        if (code && fallbackErrors.has(code)) return
        throw error
      }
      signal?.throwIfAborted()
      const { data, accountSelected } = response as SharedAccountResponse
      if (!accountSelected || data?.authenticated !== true || !Array.isArray(data.items)) {
        throw new Error("TuneWeave 未确认当前 B 站共享会话。")
      }
      await ensureCurrent(service, alias, signal)
      return data as SharedAccountProfile & { items: unknown[] }
    },
  }
}
