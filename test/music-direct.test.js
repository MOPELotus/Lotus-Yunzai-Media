import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { isMediaCommandText } from "../services/media/message.ts"
import { createMusicCommands } from "../services/music/command.ts"
import { MusicService } from "../services/music/service.ts"
import { TuneWeaveService } from "../services/tuneweave/service.ts"

test("公开直放分别查询首条歌曲与首期网易云播客，核实两种 ID 和完整音源", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-music-direct-"))
  const audio = Bun.spawnSync(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "1", "-f", "wav", "pipe:1"])
  expect(audio.exitCode).toBe(0)
  const requests = []
  const relays = []
  const cards = []
  const messages = []
  const song = { platform: "netease", ref: "netease:100", id: "100", name: "示例歌曲", duration_ms: 1000,
    artists: [{ name: "示例歌手" }], album: { cover_url: "https://p2.music.126.net/song.jpg" } }
  const episode = { platform: "netease", ref: "netease:200", id: "200", name: "测试播客", duration_ms: 1000,
    creator: { name: "播客作者" }, cover_url: "https://p2.music.126.net/episode.jpg", audio: { ...song, ref: "netease:300", id: "300" } }
  let defaults = "netease"
  let mode = "good"
  const json = data => Response.json({ ok: true, data, meta: { platform: "netease" } })
  const stream = id => ({ url: "https://m7.music.126.net/test.wav", resolved_platform: "netease", origin_track: `netease:${id}`,
    resolved_track: `netease:${id}`, trial: null, duration_ms: 1000 })
  const api = new MusicService({
    accountsFile: join(root, "accounts.yaml"), partnerAccountsFile: join(root, "partner.yaml"), tasksDir: join(root, "tasks"),
    tuneweave: new TuneWeaveService({ config: { api_url: "http://127.0.0.1:12345" }, async fetch(input, init) {
      const url = new URL(input)
      requests.push(url)
      if (url.pathname === "/v1/search") {
        expect(url.searchParams.get("platform")).toBe("netease")
        expect(url.searchParams.get("limit")).toBe("1")
        if (url.searchParams.get("type") === "track") {
          expect(url.searchParams.get("variant")).toBe("cloud")
          expect(url.searchParams.get("q")).toBe("歌曲")
          return json([{ type: "track", data: song }])
        }
        expect(url.searchParams.get("type")).toBe("voice")
        expect(url.searchParams.get("variant")).toBe("legacy")
        expect(url.searchParams.get("q")).toBe("播客")
        expect(init.redirect).toBe("error")
        if (mode === "empty") return json([])
        if (mode === "badSearch") return json([{ type: "podcast", data: { platform: "netease", id: "201" } }])
        return json([{ type: "opaque", data: { platform: "netease", kind: "voice", extensions: {
          response: { baseInfo: { id: 200, mainSong: { id: 300, name: "试验主音轨" }, dj: { nickname: "播客作者" }, duration: 1000 } },
        } } }])
      }
      if (decodeURIComponent(url.pathname) === "/v1/tracks/netease:100/stream") {
        expect(url.searchParams.get("unblock")).toBe("false")
        return json(stream(100))
      }
      expect(decodeURIComponent(url.pathname)).toBe("/v1/episodes/netease:200/stream")
      expect(url.searchParams.get("fallback")).toBe("false")
      expect(url.searchParams.get("unblock")).toBe("false")
      expect(init.redirect).toBe("error")
      return json({ ref: "netease:200", audio_ref: mode === "mismatched" ? "netease:301" : "netease:300", extensions: { episode },
        stream: { ...stream(300), ...(mode === "trial" && { trial: { start_ms: 0, end_ms: 100 } }) } })
    } }),
    async fetch(url) {
      expect(new URL(url).hostname).toBe("m7.music.126.net")
      return new Response(audio.stdout, { headers: { "content-type": "audio/wav", "content-length": String(audio.stdout.length) } })
    },
  })
  const commands = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: defaults, timeoutMs: 120000 }) })
  const context = { message_type: "group", self_id: 900, user_id: 800, group_id: 990,
    reply: async reply => { messages.push(reply); return true },
    sendMusicCard: async card => { cards.push(card); return "confirmed" },
    deliverMedia: async file => { relays.push(file.name); return "confirmed" },
  }
  const run = (message, type = "group", overrides = {}) => commands.fallback(message,
    { ...context, message_type: type, normalizedMessage: message, ...overrides })
  try {
    expect(commands.features({ ...context, normalizedMessage: "#播放播客 2" })).toEqual(["[media] 点歌"])
    expect(isMediaCommandText("#播放 https://www.bilibili.com/video/BV1dAxE6VErW")).toBe(true)
    expect(await run("#播放歌曲")).toEqual([])
    expect(await run("#播放 歌曲 1")).toEqual([])
    expect(await run("#播放播客 2")).toEqual([])
    expect(relays).toEqual(["示例歌曲.wav", "示例歌曲.wav", "测试播客.wav"])
    expect(cards.map(card => card.url)).toEqual([
      "https://music.163.com/#/song?id=100", "https://music.163.com/#/song?id=100", "https://music.163.com/#/dj?id=200",
    ])
    expect(await readdir(join(root, "tasks"))).toEqual([])
    expect(await run("#播放 播客 2", "private", { sendMusicCard: undefined })).toEqual([])
    expect(messages.at(-2)).toMatchObject({ type: "image" })
    expect(messages.at(-1)).toBe("https://music.163.com/#/dj?id=200")

    mode = "trial"
    expect(await run("#播放 播客 2")).toContain("完整播客音源")
    mode = "mismatched"
    expect(await run("#播放 播客 2")).toContain("节目身份不一致")
    mode = "badSearch"
    expect(await run("#播放 播客 2")).toContain("节目资料")
    mode = "empty"
    expect(await run("#播放 播客 2")).toContain("未找到")
    expect(relays).toHaveLength(4)
    expect(cards).toHaveLength(3)
    defaults = "qq"
    const before = requests.length
    expect(await run("#播放 播客 2")).toContain("未接入播客播放")
    expect(await run("#播放")).toContain("直接播放")
    expect(await run("#播放 歌曲", "terminal")).toBeUndefined()
    expect(await run("#上传")).toBeUndefined()
    expect(requests).toHaveLength(before)
  } finally {
    await commands.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
