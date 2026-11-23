import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CommandRegistry } from "../../../lib/commands.ts"
import { createMusicCommands } from "../services/music/command.ts"
import { MusicService } from "../services/music/service.ts"
import { TuneWeaveService } from "../services/tuneweave/service.ts"

test("播客会话查同一节目和原音轨字幕，长内容分段，歌曲歌词仍用曲目路径", async () => {
  const data = await mkdtemp(join(tmpdir(), "lotus-episode-transcript-"))
  const audio = { id: "300", ref: "netease:300", name: "样本音轨", platform: "netease" }
  const episode = { id: "200", ref: "netease:200", name: "示例播客", platform: "netease", audio }
  const text = "[00:04.10]节目字幕内容\n" + "长字幕。".repeat(999) + "\n[00:25.50]末段"
  const requests = []
  const connection = new AbortController()
  let state = "ok"
  const client = new TuneWeaveService({ config: { api_url: "http://127.0.0.1:15432" }, async fetch(input, options) {
    const url = new URL(input)
    const path = decodeURIComponent(url.pathname)
    requests.push(path)
    const response = data => Response.json({ ok: true, data })
    if (path === "/v1/search") {
      const voice = url.searchParams.get("type") === "voice"
      return response([{ type: voice ? "podcast_episode" : "track", data: voice ? episode : audio }])
    }
    if (path === "/v1/tracks/netease:300/lyrics") return response({ track_ref: audio.ref, plain: "[00:05.00]歌曲歌词" })
    expect(path).toBe("/v1/episodes/netease:200/lyrics")
    expect(options.redirect).toBe("error")
    expect(url.searchParams.has("account")).toBe(false)
    expect(new Headers(options.headers).has("X-TuneWeave-Credential")).toBe(false)
    if (state === "cancel") connection.abort()
    const hasText = state !== "missing"
    return response({
      ref: state === "wrong-episode" ? "netease:210" : episode.ref,
      audio_ref: state === "wrong-audio" ? "netease:331" : audio.ref,
      lyrics: { track_ref: state === "wrong-lyrics" ? "netease:331" : audio.ref,
        format: hasText ? "netease_voice_json" : "plain", plain: hasText ? state === "oversize" ? "长".repeat(97_001) : text : null,
        extensions: { available: hasText } },
      extensions: { episode: { ...episode, paid: state === "paid" } },
    })
  } })
  const api = new MusicService({ tuneweave: client, accountsFile: join(data, "accounts.yaml") })
  const music = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "netease", timeoutMs: 120_000 }) })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "@lotus-yunzai/media", commands: {}, fallback: music.fallback, fallbackFeatures: music.features })
  const event = { message_type: "group", self_id: 99, user_id: 42, group_id: 77, adapter: "onebot", reply: async () => true,
    groupActivitySignal: connection.signal }
  const dispatch = (msg, fields = {}, allowed = () => true) =>
    registry.dispatchFallback({ ...event, ...fields, msg }, allowed, () => false)
  try {
    expect(await dispatch("#点歌 播客 2")).toEqual([])
    const before = requests.length
    expect(await dispatch("#歌词1", { user_id: 43 })).toBeUndefined()
    expect(await dispatch("#歌词1", { group_id: 78 })).toBeUndefined()
    expect(await dispatch("#歌词1", { adapter: "milky" })).toBeUndefined()
    expect(await dispatch("#歌词1", { isDelegated: true })).toBeUndefined()
    expect(await dispatch("#歌词1", {}, names => !names.includes("[media] 点歌"))).toBeUndefined()
    expect(requests).toHaveLength(before)
    const result = await dispatch("#歌词1")
    expect(result.type).toBe("forward")
    expect(result.nodes[0]).toContain("示例播客")
    expect(result.nodes.at(-1)).toBe("https://music.163.com/#/dj?id=200")
    expect(result.nodes.slice(1, -1).length).toBeGreaterThan(2)
    expect(result.nodes.slice(1, -1).every(chunk => [...chunk].length <= 1000)).toBe(true)
    expect(result.nodes.slice(1, -1).join("")).toBe(text)
    for (const wrong of ["wrong-episode", "wrong-audio", "wrong-lyrics"]) {
      state = wrong
      expect(await dispatch("#歌词")).toContain("不一致")
    }
    for (const empty of ["missing", "paid"]) {
      state = empty
      expect(await dispatch("#歌词")).toBe("这期节目没有公开字幕。")
    }
    state = "oversize"
    expect(await dispatch("#歌词")).toContain("字幕过长")
    expect(await dispatch("#点歌 样本音轨")).toEqual([])
    expect(await dispatch("#歌词1")).toEqual({ type: "forward", nodes: ["《样本音轨》 · 歌词", "歌曲歌词"] })
    expect(await dispatch("#点歌 播客 2")).toEqual([])
    state = "cancel"
    expect(await dispatch("#歌词1")).toBeUndefined()
    expect(requests.filter(path => path.endsWith("/stream")).length).toBe(0)
  } finally {
    await music.dispose()
    await rm(data, { recursive: true, force: true })
  }
})
