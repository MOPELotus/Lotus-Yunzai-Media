import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CommandRegistry } from "../../../lib/commands.ts"
import { createMusicCommands } from "../services/music/command.ts"
import { MusicService } from "../services/music/service.ts"
import { TuneWeaveService } from "../services/tuneweave/service.ts"

test("同一机器人、协议、会话和用户才能重读选曲歌词或通过完整音源重发语音", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-reissue-fixture-"))
  const audio = Bun.spawnSync(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "1", "-f", "wav", "pipe:1"])
  expect(audio.exitCode).toBe(0)
  const tracks = ["81", "82"].map((id, index) => ({ platform: "qq", ref: "qq:" + id, id, name: "测试歌曲" + index,
    duration_ms: 1000, album: { cover_url: "https://y.gtimg.cn/test.jpg" } }))
  const trace = [], notices = [], sent = []
  let wrongIdentity = false, trial = false, enabled = true, endWith = "confirmed", waitLyric, lyricStarted
  const response = data => Response.json({ ok: true, data })
  const api = new MusicService({
    accountsFile: join(directory, "accounts.yaml"), tasksDir: join(directory, "tasks"),
    tuneweave: new TuneWeaveService({ config: { api_url: "http://127.0.0.1:12344" }, async fetch(input, init) {
      const url = new URL(input)
      const path = decodeURIComponent(url.pathname)
      trace.push(path)
      if (path === "/v1/search") return response(tracks.map(data => ({ type: "track", data })))
      const [, ref, kind] = /^\/v1\/tracks\/(qq:[0-9]+)\/(lyrics|stream)$/u.exec(path)
      if (kind === "lyrics") {
        expect(new Headers(init.headers).has("Cookie")).toBe(false)
        expect(new Headers(init.headers).has("X-TuneWeave-Credential")).toBe(false)
        lyricStarted?.resolve()
        if (waitLyric) await waitLyric.promise
        return response({ track_ref: wrongIdentity ? "qq:99" : ref, plain: "[ar:样本]\n[00:00.01]第一行 " + ref + "\n[00:01.23]第二行",
          ...(url.searchParams.get("translated") === "true" && { translated: "[00:00.01]实验译词" }) })
      }
      if (wrongIdentity) return response({ url: "https://y.gtimg.cn/test.wav", resolved_platform: "netease", origin_track: ref, resolved_track: "netease:999" })
      if (sent.length) {
        expect(url.searchParams.get("fallback")).toBe("false")
        expect(url.searchParams.get("unblock")).toBe("false")
      }
      return response({ url: "https://y.gtimg.cn/test.wav", origin_track: ref, resolved_track: ref, resolved_platform: "qq",
        duration_ms: 1000, trial: trial ? { start_ms: 0, end_ms: 100 } : null })
    } }),
    async fetch(input) {
      expect(new URL(input).hostname).toBe("y.gtimg.cn")
      return new Response(audio.stdout, { headers: { "content-type": "audio/wav", "content-length": String(audio.stdout.length) } })
    },
  })
  const commands = createMusicCommands({ openMusic: async () => {
    if (!enabled) throw new Error("点歌功能已关闭")
    return { api, defaultPlatform: "qq", timeoutMs: 120000 }
  } })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "music", commands: {}, fallback: commands.fallback, fallbackFeatures: commands.features })
  registry.registerModule({ name: "next", commands: {}, fallback: input => /^#?(语音|歌词)$/u.test(input) ? "其他模块" : undefined })
  const event = { message_type: "group", group_id: 50, user_id: 60, self_id: 70, adapter: "onebot",
    reply: async payload => { if (typeof payload === "string") notices.push(payload); return true },
    sendMusicCard: async () => "confirmed",
    deliverMedia: async file => { sent.push(file.type); return endWith },
    uploadFile: async () => { throw new Error("普通语音重发不应改为群文件") } }
  const run = (msg, changes = {}, allowed = () => true) => registry.dispatchFallback({ ...event, msg, ...changes }, allowed, () => false)
  try {
    expect(await run("歌词")).toBe("其他模块")
    expect(await run("#QQ点歌 某曲")).toEqual([])
    expect(await run("#歌词 3")).toContain("当前列表")
    expect(await run("歌词2")).toEqual({ type: "forward", nodes: ["《测试歌曲1》 · 歌词", "第一行 qq:82\n第二行", "译词", "实验译词"] })
    expect(await run("2")).toEqual([])
    for (const changes of [{ user_id: 61 }, { group_id: 51 }, { self_id: 71 }, { adapter: "milky" }, { isDelegated: true }, { message_type: "private" }]) {
      expect(await run("歌词", changes)).toBe("其他模块")
    }
    expect(await run("歌词", {}, names => !names.includes("[media] 点歌"))).toBe("其他模块")
    expect(await run("歌词")).toMatchObject({ type: "forward", nodes: [expect.stringContaining("测试歌曲1"), expect.stringContaining("qq:82"), "译词", "实验译词"] })
    expect(await run("#高清语音")).toEqual([])
    expect(notices.at(-1)).toContain("只支持普通语音")
    expect(sent).toEqual(["record", "record"])
    trial = true
    expect(await run("语音")).toContain("没有可用的完整音源")
    trial = false
    wrongIdentity = true
    expect(await run("语音")).toContain("不一致")
    expect(await run("歌词")).toContain("不一致")
    wrongIdentity = false
    endWith = "unknown"
    expect(await run("语音")).toContain("送达未确认")
    expect(sent).toEqual(["record", "record", "record"])
    endWith = "rejected"
    expect(await run("语音", { reply: async payload => typeof payload === "string" })).toContain("语音发送失败")
    expect(sent).toEqual(["record", "record", "record", "record"])
    expect(await readdir(join(directory, "tasks"))).toEqual([])

    const before = trace.length
    enabled = false
    expect(await run("歌词")).toContain("点歌功能已关闭")
    expect(trace).toHaveLength(before)
    enabled = true

    const conn = new AbortController()
    lyricStarted = Promise.withResolvers()
    waitLyric = Promise.withResolvers()
    const running = run("歌词", { groupActivitySignal: conn.signal })
    await lyricStarted.promise
    expect(await run("语音")).toContain("正在处理")
    conn.abort()
    waitLyric.resolve()
    expect(await running).toBe("其他模块")
    expect(await run("#取消")).toContain("已取消")
    expect(await run("#歌词")).toBe("其他模块")
    expect(trace.filter(path => path.endsWith("/lyrics")).every(path => path === "/v1/tracks/qq:82/lyrics")).toBe(true)
  } finally {
    waitLyric?.resolve()
    await commands.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
