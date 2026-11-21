import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import YAML from "yaml"
import { resolveData } from "../../core/path.js"
import { formatLocalIso } from "../../core/time.js"

export interface PartnerAccount {
  uid?: string | number
  nickname?: string
  qq?: string | number
  extraCount?: string | number
  comment?: boolean
  tuneweave_account?: string
  cookie?: string
  updated_at?: string
}

const accountWrites = new Map<string, Promise<PartnerAccount>>()

async function readAccounts(file: string): Promise<PartnerAccount[]> {
  try {
    const data = YAML.parse(await fs.readFile(file, "utf8")) || {}
    return Array.isArray(data.accounts) ? data.accounts : []
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }
}

// The account files used by the old NetEase partner command are shared with music login.
export class NeteasePartnerAccounts {
  readonly accountsFile: string
  now: () => Date

  constructor(accountsFile = resolveData("netease", "accounts.yaml")) {
    this.accountsFile = accountsFile
    this.now = () => new Date()
  }

  async loadAccounts() {
    const file = path.resolve(this.accountsFile)
    await accountWrites.get(file)?.catch(() => {})
    return readAccounts(file)
  }

  saveAccount(account: PartnerAccount, { signal, onlyIfLegacy = false }: { signal?: AbortSignal; onlyIfLegacy?: boolean } = {}) {
    const file = path.resolve(this.accountsFile)
    const task = (accountWrites.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
      signal?.throwIfAborted()
      let accounts = await readAccounts(file)
      const uid = String(account.uid || "")
      // Preferences belong to the authenticated UID, not to the QR alias. An
      // owner can reuse an alias to log in to a different NetEase account.
      const existing = accounts.find(item => uid && String(item.uid) === uid)
      if (onlyIfLegacy && existing?.tuneweave_account) return existing
      const normalized = {
        uid,
        nickname: account.nickname || "网易云账号",
        qq: String(account.qq || ""),
        extraCount: Number(account.extraCount ?? existing?.extraCount ?? 9999),
        comment: account.comment === undefined ? existing?.comment !== false : account.comment !== false,
        tuneweave_account: Object.hasOwn(account, "tuneweave_account") ? account.tuneweave_account || "" : existing?.tuneweave_account || "",
        updated_at: formatLocalIso(this.now()),
      }
      // Remove the previous UID entry and any account whose alias has just
      // been replaced. Keeping either could execute tasks twice or against
      // an alias that now authenticates a different UID.
      accounts = accounts.filter(item => !(uid && String(item.uid) === uid) &&
        !(normalized.tuneweave_account && item.tuneweave_account === normalized.tuneweave_account))
      accounts.push({ ...existing, ...normalized })
      for (const item of accounts) { if (item.tuneweave_account) delete item.cookie }

      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, YAML.stringify({ accounts }), { encoding: "utf8", mode: 0o600, flag: "wx" })
        signal?.throwIfAborted()
        await fs.rename(temporary, file)
      } finally { await fs.rm(temporary, { force: true }) }
      return normalized
    })
    accountWrites.set(file, task)
    void task.finally(() => { if (accountWrites.get(file) === task) accountWrites.delete(file) }).catch(() => {})
    return task
  }

}
