import type { TuneWeaveQrProfile } from "../tuneweave/auth.ts"
import { readMusicAccounts, type MusicAccount } from "./accounts.ts"
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
    if (other && other.uid !== binding.uid) throw new Error("网易云账号绑定相互冲突，请重新登录。")
    byAlias.set(binding.alias, binding)
  }
  if (music && recordedNeteaseOwner(music, owner)) {
    const binding = checked(owner, music.alias, music.uid)
    if (binding) {
      const other = byAlias.get(binding.alias)
      if (foreignAliases.has(binding.alias) || other && other.uid !== binding.uid) {
        throw new Error("网易云账号绑定相互冲突，请重新登录。")
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
  const profile = result.data
  if (!result.accountSelected || profile?.platform !== "netease" || profile.account !== alias) {
    throw new Error("TuneWeave 未确认选用的网易云账号。")
  }
  if (profile.authenticated === false) {
    throw Object.assign(new Error("网易云登录已过期，请在当前好友私聊重新扫码。"), { code: "authentication_required" })
  }
  if (profile.authenticated !== true || String(profile.user_id) !== uid) throw new Error("网易云账号不一致，请使用 #音乐重新登录 核实。")
  return profile
}
