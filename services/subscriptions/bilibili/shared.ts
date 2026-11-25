import { createTranslator as createTextTranslator } from "../../../../../packages/i18n/index.ts";
import messageCatalog from "../../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
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

interface StoredSharedAccount {
  tuneweave_account?: string | null
  saved_at?: string
  user_id?: string
}

interface SharedAccountService {
  loadAccount(): Promise<StoredSharedAccount | undefined | null>
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

function validAccountId(id: unknown): id is string {
  return typeof id === "string" && accountId.test(id) && (id.length < 20 || id <= "18446744073709551615")
}

function authenticated(profile: SharedAccountProfile | undefined, alias: string) {
  return profile?.platform === platform && profile.account === alias && profile.authenticated === true &&
    validAccountId(profile.user_id)
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
    let record: StoredSharedAccount | undefined
    try {
      service = await createService()
      record = await service.loadAccount() ?? undefined
    } catch {
      signal?.throwIfAborted()
      return
    }
    if ((needAccount && !record?.tuneweave_account) || !await capable(service, signal)) return
    return { service, record }
  }

  async function ensureCurrent(service: SharedAccountService, record: StoredSharedAccount, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const current = await enabled() ? await service.loadAccount() : undefined
    if (!current || current.tuneweave_account !== record.tuneweave_account ||
        current.saved_at !== record.saved_at || current.user_id !== record.user_id) {
      throw new Error($t("services.subscriptions.bilibili.shared.text_497084fb2a"))
    }
    signal?.throwIfAborted()
  }

  async function refresh(service: SharedAccountService, record: StoredSharedAccount, alias: string, signal?: AbortSignal) {
    await ensureCurrent(service, record, signal)
    if (!validAccountId(record.user_id)) return false
    const endpoint = service.tuneweave.config.api_url
    if (latestRefresh?.endpoint === endpoint && latestRefresh.alias === alias && Date.now() < latestRefresh.until) return false
    latestRefresh = { endpoint, alias, until: Date.now() + 60_000 }
    const response = await service.tuneweave.request("/v1/auth/session/refresh", {
      method: "POST", body: { platform, account: alias, credential_mode: "server" },
      signal, redirect: "error", accountSelection: { platform, alias },
    })
    await ensureCurrent(service, record, signal)
    const { data, accountSelected } = response as SharedAccountResponse
    if (!accountSelected || data?.platform !== platform || data?.account !== alias ||
        data.authenticated === true && data.user_id !== record.user_id) {
      throw new Error($t("services.subscriptions.bilibili.shared.text_aef43b7c73"))
    }
    return authenticated(data, alias)
  }

  return {
    async available(signal) { return Boolean(await select(signal, false)) },
    async status(signal) {
      const selected = await select(signal, false)
      if (!selected) return "unavailable"
      const { service, record } = selected
      const alias = record?.tuneweave_account
      if (!record || !alias) return "absent"
      try {
        await ensureCurrent(service, record, signal)
        const { data, accountSelected } = await service.tuneweave.request(
          "/v1/auth/session?" + new URLSearchParams({ platform, account: alias }), {
            signal, redirect: "error", accountSelection: { platform, alias },
          }) as SharedAccountResponse
        await ensureCurrent(service, record, signal)
        if (!accountSelected || data?.platform !== platform || data?.account !== alias) return "unknown"
        if (data.authenticated === false) return "expired"
        return authenticated(data, alias) && (!record.user_id || data.user_id === record.user_id) ? "active" : "unknown"
      } catch (error) {
        signal?.throwIfAborted()
        return errorCode(error) === "authentication_required" ? "expired" : "unknown"
      }
    },
    async fetchPosts(uid, signal) {
      if (!validAccountId(uid)) return
      const selected = await select(signal, true)
      if (!selected) return
      const { service, record } = selected
      const alias = record?.tuneweave_account
      if (!record || !alias) return
      const read = async () => {
        await ensureCurrent(service, record, signal)
        return service.tuneweave.request(
          "/v1/bilibili/users/" + uid + "/dynamics?" + new URLSearchParams({ account: alias }), {
            signal, redirect: "error", accountSelection: { platform, alias },
          })
      }
      let response
      try {
        try {
          response = await read()
        } catch (error) {
          if (errorCode(error) !== "authentication_required") throw error
          if (!await refresh(service, record, alias, signal)) return
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
        throw new Error($t("services.subscriptions.bilibili.shared.text_664ccf4342"))
      }
      await ensureCurrent(service, record, signal)
      return data as SharedAccountProfile & { items: unknown[] }
    },
  }
}
