import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createMusicCommands } from "../services/music/command.ts"
import { MusicService } from "../services/music/service.ts"
import { TuneWeaveService } from "../services/tuneweave/service.ts"
import { musicLength, musicMenuCovers } from "../services/music/menu.ts"

const coverUrl = "http://p2.music.126.net/officialAlbumKey/123456.jpg"
const thumbnailUrl = "https://p2.music.126.net/officialAlbumKey/123456.jpg?param=200y200"
const privateCover = "https://p2.music.126.net/privateAlbumKey/654321.jpg"
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKo0AAAAASUVORK5CYII=", "base64")
const row = (number, platform, coverUrl) => ({ number, name: "原曲", artist: "作者", coverPlatform: platform, coverUrl })

test("只读取与来源匹配的专辑封面，去重并阻止跨源跳转", async () => {
  expect(musicLength(269000)).toBe("4:29")
  expect(musicLength(4_619_076)).toBe("1:16:59")
  expect(musicLength(0)).toBeUndefined()
  expect(musicLength("329676")).toBeUndefined()
  const seen = []
  const once = await musicMenuCovers([row(1, "netease", coverUrl), row(2, "netease", coverUrl),
    row(3, "qq", coverUrl), row(4, "netease", "https://localhost/officialAlbumKey/123456.jpg")], new AbortController().signal,
  async (url, options) => {
    seen.push(url)
    expect(options.credentials).toBe("omit")
    expect(options.redirect).toBe("manual")
    return new Response(png, { headers: { "Content-Type": "image/png" } })
  })
  expect(once.map(item => Boolean(item.cover))).toEqual([true, true, false, false])
  expect(seen).toEqual([thumbnailUrl])
  seen.length = 0
  const redirect = await musicMenuCovers([row(1, "netease", coverUrl)], new AbortController().signal, async url => {
    seen.push(url)
    return Response.redirect("https://y.gtimg.cn/music/photo_new/cross.jpg")
  })
  expect(redirect[0].cover).toBeUndefined()
  expect(seen).toHaveLength(1)
})

test("点歌菜单公开行和主人云盘行保持原序号，私有封面不出网，缩放失败后仍有文字", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-music-menu-"))
  const uid = "700", alias = "lotus-nep-42"
  const contents = []
  const covers = []
  const messages = []
  const publicTrack = { id: "110", ref: "netease:110", platform: "netease", name: "公开歌曲", duration_ms: 269000,
    artists: [{ name: "歌手" }], album: { cover_url: coverUrl } }
  const privateTrack = { ...publicTrack, id: "100", ref: "netease:100", name: "本人云盘歌曲", album: { cover_url: privateCover } }
  const episode = { id: "200", ref: "netease:200", name: "公开播客", platform: "netease", cover_url: coverUrl, duration_ms: 329676,
    creator: { name: "主播" }, audio: { ...publicTrack, id: "300", ref: "netease:300" } }
  const bvid = "BV17x411w7KC", video = { platform: "bilibili", id: "bvid:" + bvid, ref: "bilibili:bvid:" + bvid, title: "公开视频",
    creators: [{ name: "作者" }], duration_ms: 402000, cover_url: "https://i0.hdslb.com/bfs/archive/fixture.jpg", extensions: { bvid } }
  const api = new MusicService({ accountsFile: join(root, "accounts.yaml"), partnerAccountsFile: join(root, "partners.yaml"),
    tuneweave: new TuneWeaveService({ config: { api_url: "http://127.0.0.1:15431" }, async fetch(input) {
      const url = new URL(input)
      const meta = { platform: "netease", account: alias }
      const body = (data, meta) => Response.json({ ok: true, data, meta })
      if (url.pathname === "/v1/account") return body({ platform: "netease", account: alias, user_id: uid, authenticated: true }, meta)
      if (url.pathname === "/v1/account/cloud/tracks") return body([{ ref: privateTrack.ref, track: privateTrack }],
        { ...meta, pagination: { offset: 0, total: 1, has_more: false } })
      if (url.searchParams.get("type") === "voice") return body([{ type: "podcast_episode", data: episode }])
      if (url.searchParams.get("platform") === "bilibili") return body([{ type: "video", data: video }])
      return body([{ type: "track", data: publicTrack }])
    } }),
  })
  await api.partner.saveAccount({ uid, qq: 42, tuneweave_account: alias })
  const module = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "netease", timeoutMs: 120000 }),
    async fetchMusicCover(url) { covers.push(url); return new Response(png, { headers: { "Content-Type": "image/png" } }) },
    async renderMusicMenu(model, options) { contents.push([model.musicRows, options.renderScale]); return Buffer.alloc(10) },
  })
  const friend = { message_type: "private", user_id: 42, self_id: 99, canManagePackages: true,
    privateCredentialSignal: new AbortController().signal, inlineImageByteLimit: 1,
    reply: async entry => { messages.push(entry); return true } }
  const run = (message, fields = {}) => module.fallback(message, { ...friend, ...fields, normalizedMessage: message })
  try {
    expect(await run("#点歌 歌曲")).toEqual([])
    expect(contents[0][0].map(({ number, name, source, length, cover }) => [number, name, source, length, Boolean(cover)]))
      .toEqual([[1, "本人云盘歌曲", "网易云盘", "4:29", false], [2, "公开歌曲", "网易云", "4:29", true]])
    expect(contents.slice(0, 2).map(([, scale]) => scale)).toEqual([4, 2])
    expect(String(messages.at(-1))).toContain("1. 本人云盘歌曲 · 歌手 · 网易云盘 · 4:29")
    expect(String(messages.at(-1))).toContain("2. 公开歌曲 · 歌手 · 网易云 · 4:29")
    expect(covers).toEqual([thumbnailUrl])

    const group = { message_type: "group", group_id: 77, canManagePackages: undefined }
    expect(await run("#点歌 播客 2", group)).toEqual([])
    expect(contents.at(-1)[0][0]).toMatchObject({ number: 1, source: "网易云播客", length: "5:29", artist: "主播" })
    expect(await run("#B站点歌 视频", group)).toEqual([])
    expect(contents.at(-1)[0][0]).toMatchObject({ number: 1, source: "B 站视频", length: "总长 6:42", artist: "作者" })
    expect(covers).not.toContain(privateCover)
  } finally {
    await module.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
