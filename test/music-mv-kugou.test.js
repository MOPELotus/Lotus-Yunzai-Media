import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMusicCommands } from "../services/music/command.ts"
import { MusicService } from "../services/music/service.ts"
import { parseMusicShare, resolveMusicShare } from "../services/music/share-link.ts"
import { TuneWeaveService } from "../services/tuneweave/service.ts"

const mv = { ref: "netease:376199", platform: "netease", id: "376199", title: "示例 MV", creators: [{ name: "示例作者" }] }
const mvUrl = "https://music.163.com/#/mv?id=376199"
const hash = "63129B9616394DD170F45F3FB45081F6"
const kg = { ref: "kugou:772647615", platform: "kugou", id: "772647615", name: "酷狗示例曲",
  extensions: { album_audio_id: "772647615", hash } }
const shareCode = "5OO6XacErV2"
const mobile = "https://m.kugou.com/share/song.html?chain=" + shareCode
const desktop = "https://www.kugou.com/share/" + shareCode + ".html"
const kgData = { mixsongid: kg.id, hash }
const html = (items, kind = "single") => new Response("<script>var dataFromSmarty = " +
  JSON.stringify(items) + ",//歌曲\n playType=" + JSON.stringify(kind) + ";</script>")

test("只解析网易云 MV 和酷狗明确的单曲页", async () => {
  const target = { platform: "netease", kind: "mv", id: mv.id, url: mvUrl }
  for (const url of [mvUrl, "https://music.163.com/mv?id=376199", "https://y.music.163.com/m/mv?id=376199"]) {
    expect(parseMusicShare(url)).toEqual(target)
  }
  expect(parseMusicShare("https://music.163.com/#/video?id=376199")).toBeUndefined()
  const proof = { platform: "kugou", kind: "track", url: desktop, id: kg.id, hash: hash.toLowerCase() }
  for (const url of [mobile, desktop, "https://t1.kugou.com/song.html?id=" + shareCode]) {
    expect(await resolveMusicShare(parseMusicShare(url), undefined, async (endpoint, init) => {
      expect(endpoint.href).toBe(desktop)
      expect(init).toMatchObject({ credentials: "omit", redirect: "error" })
      return html([kgData])
    })).toEqual(proof)
  }
  const link = parseMusicShare(mobile)
  await expect(resolveMusicShare(link, undefined, async () => html([kgData], "album"))).rejects.toThrow("单曲资料")
  await expect(resolveMusicShare(link, undefined, async () => html([kgData, kgData]))).rejects.toThrow("单曲资料")
  await expect(resolveMusicShare(link, undefined, async () => html([{ ...kgData, mixsongid: undefined }]))).rejects.toThrow("单曲资料")
  expect(parseMusicShare("https://t1.kugou.com/" + shareCode)).toBeUndefined()
  expect(parseMusicShare("https://m.kugou.com/share/song.html?chain=5OO6XacErV2&chain=bad")).toBeUndefined()
  expect(parseMusicShare("https://www.kugou.com.invalid/share/" + shareCode + ".html")).toBeUndefined()
})

test("酷狗对照单曲双标识，MV 走专用视频流、合法 CDN 和原会话回执", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-mv-kugou-"))
  const video = Bun.spawnSync(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32",
    "-t", "0.2", "-c:v", "mpeg4", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"])
  expect(video.exitCode).toBe(0)
  const trace = [], upstream = [], delivered = []
  const json = data => Response.json({ ok: true, data })
  let mode = "ok"
  let result = "confirmed"
  const api = new MusicService({ accountsFile: join(dir, "accounts.yaml"), tasksDir: join(dir, "tasks"),
    tuneweave: new TuneWeaveService({ config: { api_url: "http://127.0.0.1:12344" }, async fetch(input, init) {
      const url = new URL(input)
      const path = decodeURIComponent(url.pathname)
      trace.push(path)
      expect(new Headers(init.headers).has("Cookie")).toBe(false)
      if (path === "/v1/tracks/" + kg.ref) {
        return json(mode === "wrong-hash" ? { ...kg, extensions: { ...kg.extensions, hash: "0".repeat(32) } } : kg)
      }
      if (path === "/v1/tracks/" + kg.ref + "/stream") {
        expect(url.searchParams.get("fallback")).toBe("false")
        expect(url.searchParams.get("unblock")).toBe("false")
        return json({ url: "https://fsandroid.tx.kugou.com/test.wav", resolved_platform: "kugou", origin_track: kg.ref,
          resolved_track: kg.ref, trial: mode === "trial" ? { start_ms: 0, end_ms: 30_000 } : null })
      }
      expect(url.searchParams.get("kind")).toBe("mv")
      if (path === "/v1/videos/" + mv.ref) return json({ kind: "mv", video: mv })
      expect(path).toBe("/v1/videos/" + mv.ref + "/stream")
      expect(url.searchParams.get("resolution")).toBe("480")
      return json({ video_ref: mode === "other-mv" ? "netease:1" : mv.ref, platform: "netease", available: true,
        format: "mp4", fee: mode === "paid" ? 4 : 0, size: video.stdout.length, platform_code: 200,
        source_range: mode === "clip" ? { start_ms: 0, end_ms: 30_000 } : null,
        url: "http://example.vod.126.net/clip.mp4", extensions: { kind: "mv" } })
    } }),
    async fetch(url, init) {
      upstream.push(url)
      expect(url).toBe("https://example.vod.126.net/clip.mp4")
      expect(init).toMatchObject({ credentials: "omit", redirect: "manual" })
      return mode === "bad-redirect" ? Response.redirect("https://not-a-cdn.example/clip.mp4")
        : new Response(video.stdout, { headers: { "content-length": String(video.stdout.length) } })
    },
  })
  const commands = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "netease", timeoutMs: 120000 }),
    fetchMusicShare: async () => html([kgData]), renderMusicShare: async () => new Uint8Array([1]) })
  const context = { message_type: "group", group_id: 27, self_id: 42, user_id: 40, reply: async () => false,
    deliverMedia: async ({ type, name, path }) => {
      expect(type).toBe("video")
      expect((await Bun.file(path).bytes()).subarray(4, 8)).toEqual(new TextEncoder().encode("ftyp"))
      delivered.push(name)
      return result
    },
  }
  const run = message => commands.fallback(message, { ...context, normalizedMessage: message })
  try {
    expect(await run(mvUrl)).toEqual([{ type: "image", file: new Uint8Array([1]) }, mvUrl])
    expect(await run(mobile)).toEqual([{ type: "image", file: new Uint8Array([1]) }, desktop])
    expect(trace).toEqual(["/v1/videos/" + mv.ref, "/v1/tracks/" + kg.ref])
    mode = "trial"
    expect(await run("#播放 " + mobile)).toContain("没有可用的完整音源")
    mode = "wrong-hash"
    expect(await run("#播放 " + mobile)).toContain("音轨编号或哈希")
    for (const denied of ["other-mv", "paid", "clip"]) {
      mode = denied
      expect(await run("#播放 " + mvUrl)).toContain("没有可核实")
    }
    expect(upstream).toEqual([])
    mode = "bad-redirect"
    expect(await run("#播放 " + mvUrl)).toContain("不属于网易云 MV CDN")
    expect(upstream).toHaveLength(1)
    mode = "ok"
    expect(await run("#播放 " + mvUrl)).toEqual([])
    result = "unknown"
    expect(await run("#播放 " + mvUrl)).toContain("发送结果未确认")
    expect(delivered).toEqual(["示例 MV.mp4", "示例 MV.mp4"])
    expect(await readdir(join(dir, "tasks"))).toEqual([])
  } finally {
    await commands.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
