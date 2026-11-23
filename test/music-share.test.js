import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMusicCommands } from "../services/music/command.ts"
import { MusicService } from "../services/music/service.ts"
import { parseMusicShare, resolveMusicShare } from "../services/music/share-link.ts"
import { TuneWeaveService } from "../services/tuneweave/service.ts"

const songLink = "https://music.163.com/#/song?id=347230"
const podcastLink = "https://music.163.com/#/dj?id=3071458031"
const qqLink = "https://y.qq.com/n/ryqq/songDetail/003OUlho2HcRHC"
const shortLink = "https://163cn.tv/bkC3nsCU"
const song = { platform: "netease", ref: "netease:347230", id: "347230", name: "示例歌曲", artists: [{ name: "示例歌手" }] }
const qq = { platform: "qq", ref: "qq:003OUlho2HcRHC", id: "003OUlho2HcRHC", name: "QQ 示例歌曲" }
const episode = { platform: "netease", ref: "netease:3071458031", id: "3071458031", name: "示例节目", creator: { name: "示例主播" },
  audio: { ...song, ref: "netease:2674044559", id: "2674044559" } }

test("网易云旧歌链接、节目链接和 QQ 手机分享仅取规范官方身份", async () => {
  for (const value of [songLink, "http://music.163.com/m/song/347230", "https://y.music.163.com/m/song?userid=111&id=347230",
    "https://music.163.com/song/media/outer/url?id=347230"]) {
    expect(parseMusicShare(value)).toEqual({ platform: "netease", kind: "track", id: "347230", url: songLink })
  }
  for (const value of [podcastLink, "https://y.music.163.com/m/program?id=3071458031&userid=1"]) {
    expect(parseMusicShare(value)).toEqual({ platform: "netease", kind: "episode", id: "3071458031", url: podcastLink })
  }
  for (const value of [qqLink, "https://i.y.qq.com/v8/playsong.html?songmid=003OUlho2HcRHC", "https://i2.y.qq.com/n3/other/pages/playsong/index.html?songmid=003OUlho2HcRHC"]) {
    expect(parseMusicShare(value)).toEqual({ platform: "qq", kind: "track", id: "003OUlho2HcRHC", url: qqLink })
  }
  const short = parseMusicShare(shortLink)
  expect(await resolveMusicShare(short, undefined, async (url, options) => {
    expect(url.href).toBe(shortLink)
    expect(options).toMatchObject({ method: "HEAD", redirect: "manual", credentials: "omit" })
    return Response.redirect("https://y.music.163.com/m/song?id=347230&userid=1")
  })).toEqual(parseMusicShare(songLink))
  await expect(resolveMusicShare(short, undefined, async () => Response.redirect(qqLink))).rejects.toThrow("短链")
  await expect(resolveMusicShare(short, undefined, async () => Response.redirect("https://evil.example/music?id=347230"))).rejects.toThrow("短链")
  for (const value of ["https://music.163.com.evil.example/song?id=347230", "https://music.163.com@evil.example/song?id=347230",
    "https://y.qq.com:444/n/ryqq/songDetail/003OUlho2HcRHC", "https://music.163.com/#/user/home?id=347230",
    "https://music.163.com/#/song?id=1&id=2", "https://music.163.com/#/playlist?id=347230"]) {
    expect(parseMusicShare(value)).toBeUndefined()
  }
})

test("经实际音乐命令预览三种分享，显式播放拦试听和 ID 错配且不影响其他命令", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-music-share-"))
  const requests = []
  const played = []
  let trial = true
  let mismatch = false
  const copies = { [song.ref]: song, [episode.ref]: episode, [qq.ref]: qq }
  const api = new MusicService({ accountsFile: join(directory, "accounts.yaml"), tasksDir: join(directory, "tasks"),
    tuneweave: new TuneWeaveService({ config: { api_url: "http://127.0.0.1:12345" }, async fetch(input, init) {
      const url = new URL(input)
      requests.push(url)
      const [, ref, stream] = /\/v1\/(?:tracks|episodes)\/([^/]+)(\/stream)?$/u.exec(decodeURIComponent(url.pathname))
      if (!stream) {
        expect(new Headers(init.headers).has("Cookie")).toBe(false)
        expect(url.searchParams.size).toBe(0)
        return Response.json({ ok: true, data: mismatch ? { ...copies[ref], ref: "x:1" } : copies[ref] })
      }
      const target = ref === episode.ref ? episode.audio : copies[ref]
      expect(url.searchParams.get("fallback")).toBe("false")
      expect(url.searchParams.get("unblock")).toBe("false")
      const full = { url: "https://m7.music.126.net/test.wav", trial: trial ? { start_ms: 0, end_ms: 100 } : null,
        resolved_platform: target.platform, origin_track: target.ref, resolved_track: target.ref }
      return Response.json({ ok: true, data: ref === episode.ref ? {
        ref, audio_ref: target.ref, stream: full, extensions: { episode },
      } : full })
    } }) })
  api.prepareStream = async (track, stream) => {
    played.push({ track, stream })
    return { track, stream, voiceFile: "isolated.wav", duration: 120 }
  }
  api.cleanup = async () => {}
  const commands = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "netease", timeoutMs: 120000 }),
    renderMusicShare: async () => new Uint8Array([1, 2]) })
  const base = { message_type: "group", group_id: 44, user_id: 42, self_id: 99, reply: async () => true, deliverMedia: async () => "confirmed" }
  const run = (message, context = {}) => commands.fallback(message, { ...base, normalizedMessage: message, ...context })
  try {
    const card = { type: "json", data: JSON.stringify({ jumpUrl: "https://i.y.qq.com/v8/playsong.html?songmid=003OUlho2HcRHC" }) }
    expect(await run(`分享歌曲 ${songLink}。`)).toEqual([{ type: "image", file: new Uint8Array([1, 2]) }, songLink])
    expect(await run("", { message: [card] })).toEqual([{ type: "image", file: new Uint8Array([1, 2]) }, qqLink])
    expect(await run(podcastLink)).toEqual([{ type: "image", file: new Uint8Array([1, 2]) }, podcastLink])
    expect(requests).toHaveLength(3)
    for (const url of [songLink, podcastLink, qqLink]) expect(await run(`#播放 ${url}`)).toContain("完整")
    expect(await run("#播放 https://www.bilibili.com/video/BV1dAxE6VErW")).toBeUndefined()
    expect(await run(songLink, { isDelegated: true })).toBeUndefined()
    expect(await run(songLink, { groupActivitySignal: AbortSignal.abort() })).toBeUndefined()
    expect(played).toEqual([])
    trial = false
    mismatch = true
    expect(await run(`#播放 ${songLink}`)).toContain("身份无法核实")
    mismatch = false
    expect(await run(`#播放 ${podcastLink}`)).toEqual([])
    expect(played.map(({ track }) => track.episode_id)).toEqual([episode.id])
  } finally {
    await commands.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
