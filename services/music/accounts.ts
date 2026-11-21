import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import YAML from "yaml"
import { resolveData } from "../../core/path.ts"

const defaultFile = resolveData("music", "accounts.yaml")
export interface MusicAccount {
  alias?: string
  uid?: string | number
  nickname?: string
  credential?: string
}

export type MusicAccounts = Partial<Record<string, MusicAccount>>

interface AccountFile {
  accounts?: MusicAccounts
}

interface SaveAccountOptions {
  file?: string
  expected?: MusicAccount | null
  signal?: AbortSignal
}

const writes = new Map<string, Promise<MusicAccount | null>>()
const identity = ["alias", "uid"] as const
const accountVersion = [...identity, "credential"] as const
export async function readMusicAccounts(file = defaultFile): Promise<MusicAccounts> {
  await writes.get(file)?.catch(() => {})
  try { return (YAML.parse(await fs.readFile(file, "utf8")) as AccountFile | null)?.accounts || {} } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error }
}
export function saveMusicAccount(platform: string, account: MusicAccount, options: SaveAccountOptions = {}) {
  const file = options.file || defaultFile
  const result = (writes.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
    options.signal?.throwIfAborted()
    let data: AccountFile = {}
    try { data = YAML.parse(await fs.readFile(file, "utf8")) || {} }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    data.accounts ||= {}
    const current = data.accounts[platform]
    if (Object.hasOwn(options, "expected")) {
      const expected = options.expected
      if (expected === null ? current != null : !current || accountVersion.some(key => current[key] !== expected![key])) return null
    }
    const changedIdentity = current && identity.some(key => Object.hasOwn(account, key) && account[key] !== current[key])
    data.accounts[platform] = { ...current, ...account, ...(changedIdentity && !Object.hasOwn(account, "credential") ? { credential: "" } : {}) }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temp, YAML.stringify(data), { mode: 0o600, flag: "wx" })
      options.signal?.throwIfAborted()
      await fs.rename(temp, file)
    } finally { await fs.rm(temp, { force:true }) }
    return data.accounts[platform]
  })
  writes.set(file, result)
  void result.finally(() => { if (writes.get(file) === result) writes.delete(file) }).catch(() => {})
  return result
}
