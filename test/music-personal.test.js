import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
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

test("QQ 私人列表选歌前、播放过程中和发送语音前到期共用一次续期", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-qq-play-renewal-"))
  const accountsFile = join(root, "accounts.yaml")
  const tasksDir = join(root, "tasks")
  const localAudio = Bun.spawnSync(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "1", "-f", "wav", "pipe:1"])
  expect(localAudio.exitCode).toBe(0)
  const original = { alias: "lotus-music-qq", owner: 42, uid: "909", credential: "twc1_initial" }
  const other = { alias: "lotus-music-qq-other", owner: 42, uid: "333", credential: "twc1_other" }
  const loginExpired = () => Object.assign(new Error("合成到期"), { code: "authentication_required", platform: "qq" })
  let scenario, expired, renewals, streams, downloads, cards, checksAfterDownload
  const commandReplies = [], voice = []
  const api = new MusicService({ accountsFile, tasksDir, tuneweave: { config: { api_url: "http://127.0.0.1:7337" },
    async request(path, options) {
      const route = new URL(path, "http://127.0.0.1:7337")
      expect(options.accountSelection).toEqual({ platform: "qq", alias: original.alias })
      const data = { platform: "qq", account: original.alias, authenticated: true, user_id: original.uid }
      if (route.pathname === "/v1/auth/session/refresh") {
        renewals++
        expect(options.body).toEqual({ platform: "qq", account: original.alias, credential_mode: "both" })
        expect(options.credentials).toEqual([original.credential])
        if (scenario === "rebind") await saveMusicAccount("qq", other, { file: accountsFile })
        expired = false
        return { accountSelected: true, data: { ...data, caller_credential: { platform: "qq", value: "twc1_next" } } }
      }
      expect(route.searchParams.get("account")).toBe(original.alias)
      expect(options.credentials).toBeUndefined()
      if (route.pathname === "/v1/account") {
        if (downloads > 0 && ++checksAfterDownload === 2) {
          if (scenario === "before-image") await saveMusicAccount("qq", other, { file: accountsFile })
          if (scenario === "before-card" || scenario === "before-and-after-card") throw loginExpired()
        }
        if (expired) throw loginExpired()
        return { accountSelected: true, data }
      }
      if (route.pathname === "/v1/account/favorites/tracks") return { accountSelected: true, data: [{ ...song, album: { cover_url: "https://audio.example.test/cover.jpg" } }] }
      expect(decodeURIComponent(route.pathname)).toBe(`/v1/tracks/${song.ref}/stream`)
      expect(route.searchParams.get("fallback")).toBe("false")
      expect(route.searchParams.get("unblock")).toBe("false")
      streams++
      if (scenario === "other-platform") throw Object.assign(loginExpired(), { platform: "netease" })
      if ((scenario === "stream" && streams === 1) || scenario === "retry-fails") throw loginExpired()
      return { accountSelected: true, data: { url: "https://audio.example.test/fixture.wav", duration_ms: 1000,
        resolved_platform: "qq", origin_track: song.ref, resolved_track: song.ref } }
    },
  }, async fetch(url) {
    expect(String(url)).toBe("https://audio.example.test/fixture.wav")
    downloads++
    if ((scenario === "download" || scenario === "twice") && downloads === 1) expired = true
    return new Response(localAudio.stdout, { headers: { "content-type": "audio/wav", "content-length": String(localAudio.stdout.length) } })
  } })
  const command = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "netease", timeoutMs: 120_000 }) })
  const context = { message_type: "private", canManagePackages: true, self_id: 99, user_id: 42,
    privateCredentialSignal: new AbortController().signal,
    reply: async message => { commandReplies.push(message); return true },
    sendMusicCard: async () => {
      cards++
      if (["after-card", "twice", "before-and-after-card"].includes(scenario)) expired = true
      return "confirmed"
    },
    deliverMedia: async item => {
      expect(await Bun.file(item.path).exists()).toBe(true)
      voice.push(item.name)
      return "confirmed"
    } }
  try {
    for (scenario of ["before-selection", "stream", "download", "after-card", "twice", "rebind", "retry-fails",
      "before-card", "before-and-after-card", "before-image", "other-platform"]) {
      expired = false
      renewals = streams = downloads = cards = checksAfterDownload = commandReplies.length = voice.length = 0
      await saveMusicAccount("qq", original, { file: accountsFile })
      expect(await command.fallback("我的收藏", context)).toEqual([])
      expect(renewals).toBe(0)
      expired = scenario === "before-selection" || scenario === "rebind"
      const response = await command.fallback("1", scenario === "before-image" ? { ...context, sendMusicCard: undefined } : context)
      expect(renewals).toBe(["before-image", "other-platform"].includes(scenario) ? 0 : 1)
      expect(await command.fallback("1", context)).toBeUndefined()
      expect(await readdir(tasksDir)).toEqual([])
      const stored = (await readMusicAccounts(accountsFile)).qq
      if (scenario === "rebind" || scenario === "retry-fails") {
        expect(streams).toBe(scenario === "rebind" ? 0 : 2)
        expect(voice).toEqual([])
        expect(downloads).toBe(0)
        expect(response).toContain(scenario === "rebind" ? "账号已变更" : "合成到期")
        expect(stored).toEqual(scenario === "rebind" ? other : { ...original, credential: "twc1_next" })
      } else if (scenario === "before-image" || scenario === "other-platform") {
        expect(voice).toEqual([])
        expect(cards).toBe(0)
        expect(commandReplies.filter(message => message?.type === "image")).toHaveLength(1)
        expect(response).toContain(scenario === "before-image" ? "账号已变更" : "合成到期")
        expect(stored).toEqual(scenario === "before-image" ? other : original)
      } else if (scenario === "twice" || scenario === "before-and-after-card") {
        expect(cards).toBe(1)
        expect(streams).toBe(scenario === "twice" ? 2 : 1)
        expect(downloads).toBe(scenario === "twice" ? 2 : 1)
        expect(response).toContain("合成到期")
        expect(voice).toEqual([])
      } else {
        expect(response).toEqual([])
        expect(cards).toBe(1)
        expect(voice).toEqual(["示例歌曲.wav"])
        expect(downloads).toBe(scenario === "download" ? 2 : 1)
        expect(streams).toBe(["before-selection", "after-card", "before-card"].includes(scenario) ? 1 : 2)
        expect(commandReplies.filter(message => typeof message === "string" && message.startsWith("正在获取"))).toHaveLength(1)
        expect(stored).toEqual({ ...original, credential: "twc1_next" })
      }
    }
  } finally { await command.dispose(); await rm(root, { recursive: true, force: true }) }
}, 30_000)
