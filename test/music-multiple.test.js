import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CommandRegistry } from "../../../lib/commands.ts"
import { createMusicCommands } from "../services/music/command.ts"
import { MusicService } from "../services/music/service.ts"
import { TuneWeaveService } from "../services/tuneweave/service.ts"

test("旧多选逐页累计号可反复选一首，普通搜索号位和播放权限保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-multiple-music-"))
  const audio = Bun.spawnSync(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "1", "-f", "wav", "pipe:1"])
  expect(audio.exitCode).toBe(0)
  const track = id => ({ platform: "qq", id, ref: "qq:" + id, name: "曲目 " + id, duration_ms: 1000,
    album: { cover_url: "https://y.gtimg.cn/sample.jpg" } })
  const search = [], resolved = [], messages = [], delivered = []
  let selectedMode = "full"
  const json = data => Response.json({ ok: true, data })
  const api = new MusicService({ accountsFile: join(dir, "accounts.yaml"), tasksDir: join(dir, "tasks"), config: { search_limit: 2 },
    tuneweave: new TuneWeaveService({ config: { api_url: "http://127.0.0.1:12344" }, async fetch(input) {
      const url = new URL(input)
      const params = url.searchParams
      if (url.pathname === "/v1/search") {
        expect(params.get("platform")).toBe("qq")
        const limit = Number(params.get("limit")), offset = Number(params.get("offset"))
        search.push({ limit, offset })
        const ids = offset === 0 ? ["21", "22"] : offset === limit ? ["22", "23"] : []
        return json(ids.map(id => ({ type: "track", data: track(id) })))
      }
      const ref = decodeURIComponent(url.pathname.split("/")[3])
      expect(params.get("unblock")).toBe("false")
      resolved.push(ref)
      return json({ url: "https://y.gtimg.cn/sample.wav", resolved_platform: "qq", resolved_track: ref, origin_track: ref,
        trial: selectedMode === "trial" ? { start_ms: 0, end_ms: 500 } : null, duration_ms: selectedMode === "short" ? 10_000 : 1000 })
    } }),
    async fetch(url) {
      expect(new URL(url).hostname).toBe("y.gtimg.cn")
      return new Response(audio.stdout, { headers: { "content-type": "audio/wav", "content-length": String(audio.stdout.length) } })
    },
  })
  const music = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "qq", timeoutMs: 120000 }) })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "fixture-upper", commands: {}, fallback: msg => msg === "多选点歌 上层指令" ? "上层模块" : undefined })
  registry.registerModule({ name: "music", commands: {}, fallback: music.fallback, fallbackFeatures: music.features })
  registry.registerModule({ name: "fixture-lower", commands: {}, fallback: msg => /^(?:[0-9]+(?:[,，-][0-9]+)?|播放 视频)$/u.test(msg) ? "下层模块" : undefined })
  const event = { message_type: "group", group_id: 50, user_id: 60, self_id: 70, adapter: "onebot",
    reply: async value => { if (typeof value !== "string") return false; messages.push(value); return true },
    sendMusicCard: async () => "confirmed", deliverMedia: async file => {
      expect(file.type).toBe("record")
      expect(await Bun.file(file.path).slice(0, 4).text()).toBe("RIFF")
      delivered.push(file.name)
      return "confirmed"
    } }
  const run = (msg, changes = {}, allowed = () => true) => registry.dispatchFallback({ ...event, msg, ...changes }, allowed, () => false)
  try {
    expect(await run("多选点歌 上层指令")).toBe("上层模块")
    expect(await run("播放 视频")).toBe("下层模块")
    expect(await run("#多选QQ点歌 test", {}, names => !names.includes("[media] 点歌"))).toBeUndefined()
    expect(await run("#多选QQ点歌 test")).toEqual([])
    expect(messages.at(-1)).toContain("1. 曲目 21")
    expect(messages.at(-1)).toContain("2. 曲目 22")
    expect(await run("下一页")).toEqual([])
    expect(messages.at(-1)).toContain("3. 曲目 23")
    expect(messages.at(-1)).not.toContain("曲目 22")
    expect(await run("1,3")).toBe("下层模块")
    expect(await run("1-3")).toBe("下层模块")
    for (const changes of [{ adapter: "milky" }, { group_id: 51 }, { user_id: 61 }, { self_id: 71 }, { isDelegated: true }]) {
      expect(await run("1", changes)).toBe("下层模块")
    }
    expect(resolved).toEqual([])
    expect(await run("1")).toEqual([])
    expect(await run("#听3")).toEqual([])
    expect(await run("1")).toEqual([])
    expect(resolved).toEqual(["qq:21", "qq:23", "qq:21"])
    selectedMode = "trial"
    expect(await run("2")).toContain("没有可用的完整音源")
    selectedMode = "short"
    expect(await run("2")).toContain("音频时长不足")
    expect(delivered).toEqual(["曲目 21.wav", "曲目 23.wav", "曲目 21.wav"])
    selectedMode = "full"
    expect(await run("#下一页")).toEqual([])
    expect(messages.at(-1)).toContain("没有更多歌曲")
    expect(await run("#下一页")).toContain("没有更多歌曲")
    expect(search).toEqual([{ limit: 20, offset: 0 }, { limit: 20, offset: 20 }, { limit: 20, offset: 40 }])
    expect(await run("3")).toEqual([])
    expect(await run("#QQ多选点播 别的歌")).toEqual([])
    expect(messages.at(-1)).toContain("1. 曲目 21")
    expect(await run("#QQ点歌 普通模式")).toEqual([])
    expect(await run("#下一页")).toEqual([])
    expect(messages.at(-1)).toContain("1. 曲目 22")
    expect(messages.at(-1)).toContain("2. 曲目 23")
    expect(await run("1")).toEqual([])
    expect(await run("2")).toBe("下层模块")
    expect(delivered.slice(-2)).toEqual(["曲目 23.wav", "曲目 22.wav"])
    expect(await readdir(join(dir, "tasks"))).toEqual([])
  } finally {
    await music.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
