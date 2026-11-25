import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import type { TuneWeaveQrProfile } from "../tuneweave/auth.ts"
import { readMusicAccounts, type MusicAccount } from "./accounts.ts"
import { musicAuthenticationRequired, refreshOwnMusicAccount } from "./personal.ts"
import type { MusicService } from "./service.ts"

export const neteaseAccountId = /^[1-9]\d{0,21}$/u
export const musicAccountAlias = /^[A-Za-z0-9_-]{1,128}$/u
export const neteaseOwnerAlias = (owner: number) => `lotus-nep-${owner}`

export interface OwnedNeteaseAccount { readonly owner: number; readonly alias: string; readonly uid: string }

function checked(owner: number, alias?: string, uid?: string | number): OwnedNeteaseAccount | undefined {
  const id = String(uid ?? "")
  if (alias && musicAccountAlias.test(alias) && neteaseAccountId.test(id)) return { owner, alias, uid: id }
}

export function recordedNeteaseOwner(account: MusicAccount, owner: number) {
  return account.owner === owner || account.owner === undefined && account.alias === neteaseOwnerAlias(owner)
}

export async function findOwnedNeteaseAccount(api: Pick<MusicService, "accountsFile" | "partner">, owner: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(owner) || owner <= 0) return
  const [{ netease: music }, partner] = await Promise.all([readMusicAccounts(api.accountsFile), api.partner.loadAccounts()])
  signal?.throwIfAborted()
  const byAlias = new Map<string, OwnedNeteaseAccount>()
  const foreignAliases = new Set(partner.filter(row => row.qq && String(row.qq) !== String(owner)).map(row => row.tuneweave_account))
  for (const account of partner) {
    if (String(account.qq) !== String(owner)) continue
    const binding = checked(owner, account.tuneweave_account, account.uid)
    if (!binding || foreignAliases.has(binding.alias)) continue
    const other = byAlias.get(binding.alias)
    if (other && other.uid !== binding.uid) throw new Error($t("services.music.netease-account.text_e794fc70cd"))
    byAlias.set(binding.alias, binding)
  }
  if (music && recordedNeteaseOwner(music, owner)) {
    const binding = checked(owner, music.alias, music.uid)
    if (binding) {
      const other = byAlias.get(binding.alias)
      if (foreignAliases.has(binding.alias) || other && other.uid !== binding.uid) {
        throw new Error($t("services.music.netease-account.text_e794fc70cd"))
      }
      return binding
    }
  }
  if (music?.alias && music.owner !== undefined && music.owner !== owner) byAlias.delete(music.alias)
  return byAlias.get(neteaseOwnerAlias(owner)) ?? (byAlias.size === 1 ? [...byAlias.values()][0] : undefined)
}

export async function verifyNeteaseAccount(api: Pick<MusicService, "tuneweave">, account: OwnedNeteaseAccount, signal?: AbortSignal) {
  const { alias, uid } = account
  const route = "/v1/account?" + new URLSearchParams({ platform: "netease", account: alias })
  const result = await api.tuneweave.request<TuneWeaveQrProfile>(route, { signal, redirect: "error",
    accountSelection: { platform: "netease", alias } })
  signal?.throwIfAborted()
  return checkedProfile(result.data, result.accountSelected, alias, uid)
}

function checkedProfile(profile: TuneWeaveQrProfile | undefined, accountSelected: boolean, alias: string, uid: string) {
  if (!accountSelected || profile?.platform !== "netease" || profile.account !== alias) {
    throw new Error($t("services.music.netease-account.text_8201d4a8c3"))
  }
  if (profile.user_id != null && String(profile.user_id) !== uid) throw new Error($t("services.music.netease-account.text_c0aa58ed80"))
  if (profile.authenticated === false) {
    throw Object.assign(new Error($t("services.music.netease-account.text_176754bafe")), { code: "authentication_required" })
  }
  if (profile.authenticated !== true || String(profile.user_id) !== uid) throw new Error($t("services.music.netease-account.text_c0aa58ed80"))
  return profile
}

async function refreshServerNeteaseAccount(api: Pick<MusicService, "tuneweave">, account: OwnedNeteaseAccount, signal: AbortSignal) {
  const { alias, uid } = account
  const result = await api.tuneweave.request<TuneWeaveQrProfile>("/v1/auth/session/refresh", { method: "POST", signal, redirect: "error",
    body: { platform: "netease", account: alias, credential_mode: "server" }, accountSelection: { platform: "netease", alias } })
  signal.throwIfAborted()
  return checkedProfile(result.data, result.accountSelected, alias, uid)
}

export async function verifyOrRenewNeteaseAccount(api: MusicService, account: OwnedNeteaseAccount, signal: AbortSignal) {
  try { return await verifyNeteaseAccount(api, account, signal) }
  catch (error) {
    if (!musicAuthenticationRequired(error)) throw error
  }
  const { owner, alias, uid } = account
  const current = await findOwnedNeteaseAccount(api, owner, signal)
  if (current?.alias !== alias || current.uid !== uid) throw new Error($t("services.music.netease-account.text_8dfb3c880c"))
  const saved = (await readMusicAccounts(api.accountsFile)).netease
  if (saved && recordedNeteaseOwner(saved, owner) && saved.alias === alias && String(saved.uid) === uid &&
      saved.credential?.startsWith("twc1_")) await refreshOwnMusicAccount(api, "netease", owner, signal, account)
  else await refreshServerNeteaseAccount(api, account, signal)
  return verifyNeteaseAccount(api, account, signal)
}
