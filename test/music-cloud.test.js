import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CommandRegistry } from "../../../lib/commands.ts"
import { createMusicCommands } from "../services/music/command.ts"
import { createCloudCommands } from "../services/music/cloud-command.ts"
import { MusicService } from "../services/music/service.ts"
import { TuneWeaveService } from "../services/tuneweave/service.ts"

function wav() {
  const buffer = Buffer.alloc(44 + 24000 * 2)
  buffer.write("RIFF", 0)
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write("WAVEfmt ", 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(24000, 24)
  buffer.writeUInt32LE(48000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write("data", 36)
  buffer.writeUInt32LE(buffer.length - 44, 40)
  return buffer
}

function track(id, name, artist) {
  const ref = `netease:${id}`
  return { ref, filename: `试验-${name}.wav`, track: { platform: "netease", ref, id, name, artists: [{ name: artist }], duration_ms: 1000 } }
}

test("云盘匹配只写当前主人、原列表曲目和经核验的网易云官方编号，未知不重试", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-cloud-match-"))
  const alias = "lotus-nep-42", owner = 42, uid = "700"
  const source = track(9001, "本人云盘音频", "作者")
  const published = track(5257138, "屋顶", "温岚")
  const other = track(5257139, "另一首", "演唱者")
  const endpoint = "http://127.0.0.1:15432"
  const calls = []
  let matched, unconfirmed = false, identity = uid
  let entered, release
  const meta = { platform: "netease", account: alias }
  const api = new MusicService({
    accountsFile: join(root, "accounts.yaml"), partnerAccountsFile: join(root, "partners.yaml"),
    tuneweave: new TuneWeaveService({ config: { api_url: endpoint }, async fetch(input, options) {
      const url = new URL(input)
      const path = decodeURIComponent(url.pathname)
      const queryAlias = url.searchParams.get("account")
      calls.push({ path, queryAlias, method: options.method, body: options.body && JSON.parse(options.body) })
      expect(options.redirect).toBe("error")
      expect(new Headers(options.headers).has("X-TuneWeave-Credential")).toBe(false)
      if (path.startsWith("/v1/tracks/")) {
        expect(queryAlias).toBeNull()
        return Response.json({ ok: true, data: path.endsWith(published.ref) ? published.track : other.track })
      }
      expect(queryAlias).toBe(alias)
      if (path === "/v1/account") return Response.json({ ok: true, meta,
        data: { platform: "netease", account: alias, user_id: identity, authenticated: true } })
      const item = { ...source, matched_track_ref: matched }
      if (path.endsWith("/tracks/details")) {
        expect(url.searchParams.get("refs")).toBe(source.ref)
        return Response.json({ ok: true, meta, data: [item] })
      }
      if (path.endsWith("/tracks")) return Response.json({ ok: true,
        meta: { ...meta, pagination: { offset: 0, total: 1, has_more: false } }, data: [item] })
      expect(path).toBe("/v1/account/cloud/matches")
      expect(options.method).toBe("POST")
      const expected = "netease:" + JSON.parse(options.body).target_track_id
      if (entered) {
        entered()
        await new Promise(resolve => { release = resolve })
      }
      if (!unconfirmed) matched = expected
      return Response.json({ ok: true, meta, data: { cloud_track_ref: source.ref, target_track_ref: expected,
        matched: true, extensions: { cloud_user_id: uid, response: { code: unconfirmed ? 400 : 200 } } } })
    } }),
  })
  await api.partner.saveAccount({ uid, qq: owner, tuneweave_account: alias })
  const command = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "netease", timeoutMs: 120_000 }) })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "@lotus-yunzai/media", commands: {}, fallback: command.fallback, fallbackFeatures: command.features })
  const friend = { message_type: "private", self_id: 99, user_id: owner, adapter: "onebot",
    privateCredentialSignal: new AbortController().signal, reply: async () => true }
  const dispatch = (msg, changes = {}) => registry.dispatchFallback({ ...friend, ...changes, msg }, () => true, () => true, msg, { canManagePackages: true })
  const writes = () => calls.filter(call => call.path.endsWith("/matches"))
  try {
    expect(await dispatch("#云盘匹配 1 5257138", { message_type: "group" })).toContain("好友私聊")
    expect(await dispatch("#云盘匹配 1 5257138", { isDelegated: true })).toContain("好友私聊")
    expect(await dispatch("#云盘匹配 1 https://music.163.com/#/dj?id=5257138")).toContain("单曲链接")
    expect(calls).toHaveLength(0)
    expect(await dispatch("#我的云盘")).toEqual([])
    expect(await dispatch("#云盘匹配 1 5257138", { user_id: 43 })).toContain("自己的网易云账号")
    expect(await dispatch("#云盘匹配 1 5257138", { adapter: "milky" })).toContain("先使用")
    expect(await dispatch("#云盘匹配 2 5257138")).toContain("当前页")
    identity = "701"
    expect(await dispatch("#云盘匹配 1 5257138")).toContain("账号不一致")
    identity = uid
    const wait = new Promise(resolve => { entered = resolve })
    const pending = dispatch("#云盘匹配 1 https://music.163.com/#/song?id=5257138")
    await wait
    expect(await dispatch("#云盘匹配 1 5257138")).toContain("请稍候")
    release()
    expect(await pending).toContain("已匹配《屋顶》")
    expect(writes()).toEqual([{ path: "/v1/account/cloud/matches", queryAlias: alias, method: "POST",
      body: { user_id: uid, cloud_track_id: "9001", target_track_id: "5257138" } }])
    entered = undefined
    expect(await dispatch("#云盘匹配 1 5257138")).toContain("先使用")
    expect(await dispatch("#我的云盘")).toEqual([])
    expect(await dispatch("#云盘匹配 1 5257138")).toContain("已关联")
    expect(writes()).toHaveLength(1)
    expect(await dispatch("#我的云盘")).toEqual([])
    unconfirmed = true
    expect(await dispatch("#云盘匹配 1 5257139")).toContain("结果未确认")
    expect(await dispatch("#云盘匹配 1 5257139")).toContain("先使用")
    expect(writes()).toHaveLength(2)
  } finally {
    release?.()
    await command.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("私人云盘沿音乐命令入口隔离读、筛选、翻页、播放和唯一一次上传", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-music-cloud-"))
  const bytes = wav()
  const rows = Array.from({ length: 12 }, (_, index) => track(100 + index, `隔离曲目 ${index + 1}`, index === 11 ? "第二位歌手" : "测试歌手"))
  const requests = []
  const messages = []
  const relayed = []
  const owner = new AbortController()
  let remoteUid = "700"
  let uploadConfirmation = true
  let pageFault = false
  let readCount = 0
  let out = "good"
  const response = (data, pagination, account = "lotus-nep-42") => Response.json({ ok: true, data,
    meta: { platform: "netease", account, ...(pagination && { pagination }) } })
  const api = new MusicService({
    tuneweave: new TuneWeaveService({ config: { api_url: "http://127.0.0.1:15432" }, async fetch(input, options) {
      const url = new URL(input)
      const method = options.method
      requests.push([url.pathname, method, url.searchParams.get("offset")])
      if (url.pathname === "/v1/search") {
        expect(url.searchParams.get("account")).toBeNull()
        return Response.json({ ok: true, data: [{ type: "track", data: track(300, "公开结果", "测试歌手").track }] })
      }
      expect(url.searchParams.get("account")).toBe("lotus-nep-42")
      expect(url.searchParams.get("platform")).toBe(url.pathname.endsWith("/download") ? null : "netease")
      expect(options.redirect).toBe("error")
      expect(new Headers(options.headers).has("authorization")).toBe(false)
      if (url.pathname === "/v1/account") return response({ platform: "netease", account: "lotus-nep-42", user_id: remoteUid, authenticated: true })
      if (url.pathname === "/v1/account/cloud/tracks") {
        const offset = Number(url.searchParams.get("offset"))
        if (offset === 0) return response(rows.slice(0, 10), { offset, total: rows.length, next_offset: 10, has_more: true,
          extensions: { storage_size: 10485760, storage_max_size: 104857600 } })
        expect(offset).toBe(10)
        return response(pageFault ? rows.slice(0, 2) : rows.slice(10), { offset, total: rows.length, has_more: false })
      }
      if (url.pathname === "/v1/account/cloud/uploads") {
        expect(method).toBe("POST")
        expect(new Headers(options.headers).get("content-type")).toBe("audio/wav")
        expect(url.searchParams.get("song_name")).toBe("你的歌")
        expect(url.searchParams.get("artist")).toBe("歌手")
        expect(Buffer.from(options.body).equals(bytes)).toBe(true)
        return response({ track_ref: "netease:999", published: uploadConfirmation })
      }
      const path = decodeURIComponent(url.pathname)
      expect(path).toBe("/v1/account/cloud/tracks/netease:111/download")
      return response({ ref: "netease:111", platform: "netease", url: "https://m7.music.126.net/isolation.wav",
        duration_ms: 1000, available: true })
    } }),
    tasksDir: join(root, "tasks"), partnerAccountsFile: join(root, "partners.yaml"),
    accountsFile: join(root, "accounts.yaml"),
    async fetch(input, options) {
      const url = new URL(input)
      expect(url.hostname).toBe("m7.music.126.net")
      expect(new Headers(options.headers).has("cookie")).toBe(false)
      expect(new Headers(options.headers).has("x-tuneweave-credential")).toBe(false)
      if (out === "offsite") return new Response(null, { status: 302, headers: { Location: "https://offsite.invalid/leak" } })
      return new Response(bytes, { headers: { "content-type": "audio/wav", "content-length": String(bytes.length) } })
    },
  })
  await api.partner.saveAccount({ uid: "700", qq: 42, tuneweave_account: "lotus-nep-42" })
  const music = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "netease", timeoutMs: 120000 }) })
  const context = { message_type: "private", self_id: 91, user_id: 42, canManagePackages: true,
    privateCredentialSignal: owner.signal, canReadAttachments: true, reply: async message => { messages.push(message); return true },
    deliverMedia: async media => { relayed.push({ name: media.name, bytes: await Bun.file(media.path).bytes() }); return "confirmed" } }
  const run = (message, options = {}) => music.fallback(message, { ...context, normalizedMessage: message, ...options })
  const routes = name => requests.filter(([path]) => path === `/v1/${name}`).length
  try {
    expect(await run("#rNc", { message_type: "group" })).toContain("好友私聊")
    expect(await run("#rNc", { isDelegated: true })).toContain("好友私聊")
    expect(await run("#rNc", { user_id: 43 })).toContain("绑定自己的网易云账号")
    expect(requests).toHaveLength(0)
    expect(music.features({ ...context, normalizedMessage: "#rNc" })).toEqual(["[media] 点歌"])
    expect(await run("#rNc")).toEqual([])
    expect(messages.at(-1).type).toBe("image")
    expect(routes("account/cloud/tracks")).toBe(2)
    expect(await run("#云盘下一页")).toEqual([])
    expect(routes("account/cloud/tracks")).toBe(2)
    expect(await run("#听云盘 3")).toContain("当前页")
    expect(await run("#听云盘 2")).toEqual([])
    expect(relayed[0].name).toBe("隔离曲目 12.wav")
    expect(Buffer.from(relayed[0].bytes).toString("ascii", 0, 4)).toBe("RIFF")
    expect(await readdir(join(root, "tasks"))).toEqual([])

    expect(await run("#云盘搜索 第二位歌手")).toEqual([])
    expect(await run("#云盘下一页")).toContain("没有更多")
    expect(await run("#网易点歌 第二位歌手")).toEqual([])
    expect(await run("#听1")).toEqual([])
    expect(relayed.at(-1).name).toBe("隔离曲目 12.wav")
    const privateRequests = routes("account")
    expect(await run("#网易点歌 第二位歌手", { message_type: "group", group_id: 20 })).toEqual([])
    expect(routes("account")).toBe(privateRequests)
    out = "offsite"
    expect(await run("#听云盘 1")).toContain("音频地址无效")
    expect(relayed).toHaveLength(2)
    expect(await readdir(join(root, "tasks"))).toEqual([])

    pageFault = true
    expect(await run("#更新云盘")).toContain("刷新期间发生变化")
    expect(await run("#rNc 第2页")).toEqual([])
    expect(routes("account/cloud/tracks")).toBe(4)
    pageFault = false
    expect(await run("#清除云盘缓存")).toContain("已清除")
    expect(await run("#云盘更新")).toContain("共 12 首")
    expect(routes("account/cloud/tracks")).toBe(6)
    remoteUid = "701"
    expect(await run("#rNc")).toContain("账号不一致")
    remoteUid = "700"

    const attachment = { name: "歌手-你的歌.wav", size: bytes.length, read: async () => { readCount++; return bytes } }
    expect(await run("#rNu", { reply_id: 45, lookupReply: async () => ({ user_id: 55, attachment }) })).toContain("引用自己")
    expect(await run("上传网盘", { attachment: { ...attachment, name: "unexpected.txt" } })).toContain("扩展名一致")
    expect(await run("#上传云盘", { attachment })).toContain("已存入")
    expect(readCount).toBe(2)
    expect(routes("account/cloud/uploads")).toBe(1)
    uploadConfirmation = false
    expect(await run("#rnu", { reply_id: 45, lookupReply: async () => ({ user_id: 42, attachment }) })).toContain("结果未确认")
    expect(routes("account/cloud/uploads")).toBe(2)

    const abort = new AbortController()
    const cloud = createCloudCommands({ signal: abort.signal, ownerSignal: current => current.privateCredentialSignal, open: async () => api,
      render: async () => { abort.abort(); return undefined }, sendVoice: async () => { throw new Error("unexpected media") } })
    const before = messages.length
    expect(await cloud.handle("#我的云盘", context)).toEqual([])
    expect(messages.length).toBe(before)
  } finally {
    await music.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
