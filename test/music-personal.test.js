import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CommandRegistry } from "../../../lib/commands.ts"
import { readMusicAccounts, saveMusicAccount } from "../services/music/accounts.ts"
import { createMusicCommands } from "../services/music/command.ts"
import { MusicService } from "../services/music/service.ts"
import { refreshOwnMusicAccount } from "../services/music/personal.ts"

const song = { id: "000cflsu1FG3rW", ref: "qq:000cflsu1FG3rW", platform: "qq", name: "示例歌曲", extensions: { numeric_id: "671376" } }

test("来首歌只读公开 QQ 推荐和固定曲目，试听时保留同平台链接", async () => {
  const requests = []
  const api = new MusicService({ tuneweave: { config: { api_url: "http://127.0.0.1:7337" }, async request(path, options) {
    const url = new URL(path, "http://127.0.0.1:7337")
    requests.push(url.pathname)
    expect(options.credentials).toBeUndefined()
    expect(url.searchParams.get("account")).toBeNull()
    if (url.pathname === "/v1/recommendations/feed") {
      expect(url.searchParams.get("direction")).toBe("forward")
      return { shelves: [{ style: 0, niches: [{ cards: [{ kind: "track", id: "12", ref: "qq:12" }] }] },
        { style: 1, niches: [{ cards: [{ kind: "playlist", id: "45", ref: "qq:45" }, { kind: "track", id: "671376", ref: "qq:671376" }] }] }] }
    }
    if (decodeURIComponent(url.pathname) === "/v1/tracks/qq:671376") return song
    expect(decodeURIComponent(url.pathname)).toBe(`/v1/tracks/${song.ref}/stream`)
    expect(url.searchParams.get("fallback")).toBe("false")
    return { url: "https://audio.example.test/sample.mp3", resolved_platform: "qq", origin_track: song.ref, resolved_track: song.ref, trial: true }
  } } })
  const command = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "netease", timeoutMs: 120_000 }) })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "@lotus-yunzai/media", commands: {}, fallback: command.fallback, fallbackFeatures: command.features })
  const event = { message_type: "group", self_id: 99, user_id: 42, group_id: 77, msg: "来首歌", reply: async () => true }
  try {
    expect(await registry.dispatchFallback(event, names => !names.includes("[media] 点歌"), () => false)).toBeUndefined()
    expect(requests).toEqual([])
    const reply = await registry.dispatchFallback(event, () => true, () => false)
    expect(reply).toContain("QQ 音乐推荐《示例歌曲》")
    expect(reply).toContain("没有可核实的完整音源")
    expect(reply).toContain("https://y.qq.com/n/ryqq/songDetail/000cflsu1FG3rW")
    expect(requests).toHaveLength(3)
  } finally { await command.dispose() }
})

test("QQ 私人目录同账号选用，明确到期后只续期一次，换绑不发音轨", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-music-private-"))
  const accountsFile = join(root, "accounts.yaml")
  const requests = []
  const responses = []
  const original = { alias: "lotus-music-qq", owner: 42, uid: "909", credential: "twc1_fixture-qq" }
  let expired = true
  let match = true
  let selected = true
  let onCollection
  const api = new MusicService({ accountsFile, tuneweave: { config: { api_url: "http://127.0.0.1:7337" }, async request(path, options) {
    const url = new URL(path, "http://127.0.0.1:7337")
    requests.push(decodeURIComponent(url.pathname))
    expect(options.accountSelection).toEqual({ platform: "qq", alias: original.alias })
    if (url.pathname === "/v1/auth/session/refresh") {
      expect(options.body).toEqual({ platform: "qq", account: original.alias, credential_mode: "both" })
      expect(options.credentials).toEqual([original.credential])
      expired = false
      return { accountSelected: true, data: { platform: "qq", account: original.alias, authenticated: true, user_id: original.uid,
        caller_credential: { value: "twc1_rotated", platform: "qq" } } }
    }
    expect(options.credentials).toBeUndefined()
    expect(url.searchParams.get("account")).toBe(original.alias)
    if (url.pathname === "/v1/account") {
      if (expired) throw Object.assign(new Error("合成到期"), { code: "authentication_required" })
      return { accountSelected: true, data: { platform: "qq", account: original.alias, authenticated: true, user_id: match ? original.uid : "808" } }
    }
    if (url.pathname === "/v1/account/favorites/tracks") expect(url.searchParams.get("offset")).toBe("10")
    if (decodeURIComponent(url.pathname) === "/v1/playlists/qq:dir:202/tracks") expect(url.searchParams.get("limit")).toBe("30")
    if (url.pathname === "/v1/recommendations/tracks") expect(url.searchParams.get("source")).toBe("personalized")
    await onCollection?.()
    return { accountSelected: selected, data: [song] }
  } } })
  const command = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "netease", timeoutMs: 120_000 }) })
  const context = { message_type: "private", canManagePackages: true, self_id: 99, user_id: 42,
    privateCredentialSignal: new AbortController().signal, reply: async message => { responses.push(message); return true } }
  try {
    await saveMusicAccount("qq", original, { file: accountsFile })
    expect(await command.fallback("我的收藏2", { ...context, user_id: 43 })).toContain("重新扫码")
    expect(await command.fallback("我的收藏2", { ...context, message_type: "group" })).toContain("好友私聊")
    expect(requests).toEqual([])
    expect(await command.fallback("我的收藏2", context)).toEqual([])
    expect((await readMusicAccounts(accountsFile)).qq.credential).toBe("twc1_rotated")
    expect(requests.filter(path => path === "/v1/auth/session/refresh")).toHaveLength(1)
    expect(requests).toContain("/v1/account/favorites/tracks")
    expect(responses).toHaveLength(1)
    expect(await command.fallback("1", { ...context, adapter: "milky" })).toBeUndefined()
    expect(await command.fallback("每日30首", context)).toEqual([])
    expect(requests).toContain("/v1/playlists/qq:dir:202/tracks")
    expect(await command.fallback("个性电台", context)).toEqual([])
    expect(requests).toContain("/v1/recommendations/tracks")
    match = false
    expect(await command.fallback("1", context)).toContain("身份无法核实")
    expect(requests.some(path => path.endsWith("/stream"))).toBe(false)
    expect(requests.filter(path => path === "/v1/auth/session/refresh")).toHaveLength(1)
    match = true
    selected = false
    const shown = responses.length
    expect(await command.fallback("日推", context)).toContain("未确认选用")
    selected = true
    onCollection = () => saveMusicAccount("qq", { ...original, uid: "882", owner: 43 }, { file: accountsFile })
    expect(await command.fallback("日推", context)).toContain("重新扫码")
    expect(responses).toHaveLength(shown)
    expect(requests.filter(path => path === "/v1/auth/session/refresh")).toHaveLength(1)
  } finally { await command.dispose(); await rm(root, { recursive: true, force: true }) }
})

test("网易云续期严格用本人历史账号别名，账号变更或取消不能写回", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-music-refresh-"))
  const accountsFile = join(root, "accounts.yaml")
  const prev = { alias: "lotus-nep-42", uid: "441", credential: "twc1_netease-fixture" }
  let called = 0
  let onRefresh
  const api = new MusicService({ accountsFile, tuneweave: { config: { api_url: "http://127.0.0.1:7337" }, async request(path, options) {
    called++
    expect(path).toBe("/v1/auth/session/refresh")
    expect(options.credentials).toEqual([prev.credential])
    expect(options.body).toEqual({ platform: "netease", account: prev.alias, credential_mode: "both" })
    await onRefresh?.()
    return { accountSelected: true, data: { platform: "netease", account: prev.alias, user_id: prev.uid, authenticated: true,
      caller_credential: { value: "twc1_netease-next", platform: "netease" } } }
  } } })
  const signal = new AbortController()
  try {
    await saveMusicAccount("netease", prev, { file: accountsFile })
    await expect(refreshOwnMusicAccount(api, "netease", 43, signal.signal)).rejects.toThrow("重新扫码")
    expect(called).toBe(0)
    onRefresh = () => saveMusicAccount("netease", { alias: "lotus-nep-88", uid: "882", owner: 88, credential: "twc1_other" }, { file: accountsFile })
    await expect(refreshOwnMusicAccount(api, "netease", 42, signal.signal)).rejects.toThrow("重新扫码")
    expect((await readMusicAccounts(accountsFile)).netease.credential).toBe("twc1_other")
    await saveMusicAccount("netease", { ...prev, owner: 42 }, { file: accountsFile })
    onRefresh = () => signal.abort()
    await expect(refreshOwnMusicAccount(api, "netease", 42, signal.signal)).rejects.toThrow()
    expect((await readMusicAccounts(accountsFile)).netease.credential).toBe(prev.credential)
    onRefresh = undefined
    await refreshOwnMusicAccount(api, "netease", 42, new AbortController().signal)
    expect((await readMusicAccounts(accountsFile)).netease.credential).toBe("twc1_netease-next")
    expect(called).toBe(3)
  } finally { await rm(root, { recursive: true, force: true }) }
})
