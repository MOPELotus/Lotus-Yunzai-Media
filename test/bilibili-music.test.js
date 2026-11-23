import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CommandRegistry } from "../../../lib/commands.ts"
import { createMusicCommands } from "../services/music/command.ts"
import { MusicService } from "../services/music/service.ts"

const bvid = "BV17x411w7KC", ref = `bilibili:bvid:${bvid}`, part = "bilibili:cid:279786"
const media = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/86/97/279786/279786_da3-1-30216.m4s"
const video = { ref, platform: "bilibili", id: `bvid:${bvid}`, title: "<em>视频</em>音轨", creators: [{ name: "视频作者" }],
  extensions: { bvid, first_cid: 279786, pay: false, ugc_pay: false } }
const partResult = { ref: part, id: "cid:279786", platform: "bilibili", video_ref: ref, page: 1, duration_ms: 5000,
  extensions: { bvid, cid: 279786 } }
const stream = { url: media, video_ref: ref, part_ref: part, platform: "bilibili", available: true, mime_type: "audio/mp4",
  duration_ms: 5000, codec: "mp4a.40.2", headers: { Cookie: "secret", Authorization: "secret" },
  extensions: { source: "video_playback_manifest" } }

test("点歌与裸点播以视频和分 P 身份选择 TuneWeave 音轨", async () => {
  const calls = []
  const output = []
  let detail = video
  let selectedPart = partResult
  let selectedStream = stream
  let prepared = 0
  const api = new MusicService({ tuneweave: { config: { api_url: "http://127.0.0.1:7337" }, async request(path, options) {
    const url = new URL(path, "http://127.0.0.1:7337"), pathname = decodeURIComponent(url.pathname)
    calls.push({ pathname, query: url.searchParams })
    expect(options.credentials).toBeUndefined()
    expect(url.searchParams.has("account")).toBe(false)
    if (pathname === "/v1/search") {
      expect(url.searchParams.get("platform")).toBe("bilibili")
      expect(url.searchParams.get("type")).toBe("video")
      return [{ type: "track", data: video }, { type: "video", data: { ...video, ref: "qq:different" } },
        { type: "video", data: video }]
    }
    expect(url.searchParams.get("kind")).toBe("video")
    if (pathname.endsWith("/parts")) {
      expect(url.searchParams.get("limit")).toBe("1")
      return [selectedPart]
    }
    if (pathname.endsWith("/audio-stream")) {
      expect(url.searchParams.get("part")).toBe(part)
      expect(url.searchParams.get("codec")).toBe("aac")
      return selectedStream
    }
    expect(pathname).toBe("/v1/videos/" + ref)
    return { kind: "video", video: detail }
  } } })
  api.prepareStream = async (track, audio) => {
    prepared++
    expect(track.name).toBe("视频音轨")
    expect(track.platform).toBe("bilibili")
    expect(audio.headers).toEqual({ Referer: "https://www.bilibili.com/video/" + bvid })
    expect(audio.url).toBe(media)
    return { voiceFile: "/probe.wav", duration: 5, track, stream: audio }
  }
  api.cleanup = async () => {}
  const command = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "netease", timeoutMs: 30_000 }) })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "@lotus-yunzai/media", commands: {}, fallback: command.fallback, fallbackFeatures: command.features })
  const event = { message_type: "group", self_id: 99, user_id: 42, group_id: 77, adapter: "onebot",
    reply: async message => { output.push(message); return true },
    deliverMedia: async () => { output.push("delivered"); return "confirmed" } }
  const dispatch = (msg, changes = {}) => registry.dispatchFallback({ ...event, ...changes, msg }, () => true, () => false)
  try {
    expect(await dispatch("#哔哩哔哩点歌 示例")).toEqual([])
    expect(await dispatch("1", { group_id: 78 })).toBeUndefined()
    expect(await dispatch("1", { user_id: 43 })).toBeUndefined()
    expect(await dispatch("1", { adapter: "milky" })).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(await dispatch("下一页")).toEqual([])
    expect(calls.at(-1).query.get("offset")).toBe(String(api.config.search_limit))
    expect(await dispatch("1")).toEqual([])
    expect(output).toContain("delivered")
    expect(output.some(value => typeof value === "string" && value.includes("https://www.bilibili.com/video/" + bvid))).toBe(true)
    expect(await dispatch("#歌词")).toContain("没有曲目歌词")
    expect(await dispatch("#语音")).toEqual([])
    expect(prepared).toBe(2)
    expect(await dispatch("哔哩点播 示范")).toEqual([])
    expect(prepared).toBe(3)
    for (const changes of [{ part_ref: "bilibili:cid:999" }, { video_ref: "bilibili:bvid:BV1Jt411P77c" },
      { url: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/86/97/999/999_da3-1-30216.m4s" },
      { source_range: { end_ms: 2500 } }, { duration_ms: 1500 }, { trial: true }, { fee: 1 }]) {
      selectedStream = { ...stream, ...changes }
      expect(await dispatch("哔哩播放 示范")).toContain("完整公开音轨")
    }
    selectedStream = stream
    selectedPart = { ...partResult, page: 2 }
    expect(await dispatch("哔哩播放 示范")).toContain("完整公开音轨")
    selectedPart = partResult
    detail = { ...video, extensions: { ...video.extensions, first_cid: 999 } }
    expect(await dispatch("哔哩播放 示范")).toContain("完整公开音轨")
    detail = { ...video, extensions: { ...video.extensions, pay: true } }
    expect(await dispatch("哔哩播放 示范")).toContain("完整公开音轨")
    expect(prepared).toBe(3)
  } finally { await command.dispose() }
})

test("B 站音轨二次核对实际解码时长，拒绝重定向后的其他分段", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-bili-audio-test-"))
  const file = join(root, "fixture.m4a")
  const generated = Bun.spawnSync(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:duration=1", "-c:a", "aac", file])
  try {
    expect(generated.exitCode).toBe(0)
    const blob = Bun.file(file)
    let redirect = false
    let requests = 0
    const api = new MusicService({ tasksDir: join(root, "tasks"), fetch: async url => {
      requests++
      expect(new URL(url).href).toBe(media)
      return redirect ? new Response(null, { status: 302, headers: { Location: media.replaceAll("279786", "999") } })
        : new Response(blob, { headers: { "Content-Length": String(blob.size) } })
    } })
    const track = { ref, platform: "bilibili", id: bvid, name: "视频音轨" }
    const source = { url: media, bilibili_part_ref: part, duration_ms: 1000 }
    const complete = await api.prepareStream(track, source)
    try { expect(complete.duration).toBeCloseTo(1) }
    finally { await api.cleanup(complete) }
    await expect(api.prepareStream(track, { ...source, duration_ms: 2700 })).rejects.toThrow("未完整解码")
    redirect = true
    await expect(api.prepareStream(track, source)).rejects.toThrow("地址无效")
    expect(requests).toBe(3)
  } finally { await rm(root, { recursive: true, force: true }) }
})
