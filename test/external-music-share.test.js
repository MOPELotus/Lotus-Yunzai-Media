import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadMedia } from "../services/media/download.ts"
import { readExternalMusicShare } from "../services/music/external-share.ts"
import { parseMusicShare, resolveMusicShare } from "../services/music/share-link.ts"
import { createMusicCommands } from "../services/music/command.ts"
import { MusicService } from "../services/music/service.ts"
import { TuneWeaveService } from "../services/tuneweave/service.ts"

const apple = "https://music.apple.com/cn/album/hectopascal/1468323115?i=1468323724"
const spotify = "https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8"
const sodaShort = "https://qishui.douyin.com/s/iQfNnBfJ/"
const soda = "https://music.douyin.com/qishui/share/track?track_id=7430806374525323280"
const qq = "https://y.qq.com/n/ryqq_v2/songDetail/480622732"
const mid = "003lfH1n1uKTn4"
const signal = new AbortController().signal
test("Apple 和 Spotify 官方分享逐号验证，屏蔽列表及恶意地址", async () => {
  for (const url of [apple.replace(/\?.*/u, ""), apple + "&i=1", spotify.replace("track", "album"),
    soda.replace("/track", "/playlist"), soda + "&track_id=2", spotify.replace("open.spotify.com", "open.spotify.com@localhost")]) {
    expect(parseMusicShare(url)).toBeUndefined()
  }
  const calls = []
  const transport = async (url, options) => {
    calls.push(url.href)
    expect(options.credentials).toBe("omit")
    if (url.hostname === "itunes.apple.com") {
      expect(url.searchParams.get("country")).toBe("CN")
      expect(url.searchParams.get("id")).toBe("1468323724")
      return Response.json({ results: [
        { trackId: 9, kind: "song", wrapperType: "track", trackName: "另一录音" },
        { trackId: 1468323724, kind: "song", wrapperType: "track", artistName: "zzz - Anime on Piano", trackName: "hectopascal" },
      ] })
    }
    if (url.hostname === "open.spotify.com") {
      expect(url.searchParams.get("url")).toBe(spotify)
      return Response.json({ provider_name: "Spotify", title: "Never Gonna Give You Up",
        html: '<iframe src="' + spotify.replace("/track/", "/embed/track/") + '?utm_source=oembed"></iframe>' })
    }
    throw new Error("不应出站")
  }
  expect(await readExternalMusicShare(parseMusicShare(apple), signal, transport)).toEqual({
    title: "hectopascal", author: "zzz - Anime on Piano", url: apple,
  })
  expect(await readExternalMusicShare(parseMusicShare(spotify), signal, transport)).toEqual({ title: "Never Gonna Give You Up", url: spotify })
  expect(calls).toHaveLength(2)
})

test("汽水短链只提取官方 ID，禁止跨站或跨资源类型", async () => {
  expect(await resolveMusicShare(parseMusicShare(sodaShort), signal, async (url, init) => {
    expect(url.href).toBe(sodaShort)
    expect(init).toMatchObject({ credentials: "omit", redirect: "manual" })
    return Response.redirect(soda + "&sec_sharer_id=ignored")
  })).toEqual({ platform: "soda", kind: "track", id: "7430806374525323280", url: soda })
  await expect(resolveMusicShare(parseMusicShare(sodaShort), signal, async () =>
    Response.redirect(soda.replace("music.douyin.com", "example.test")))).rejects.toThrow("未指向")
  await expect(resolveMusicShare(parseMusicShare(sodaShort), signal, async () =>
    Response.redirect(soda.replace("/track", "/playlist")))).rejects.toThrow("未指向")
})

test("汽水 beta.4 公开搜索的空响应有定向提示，不回显上游详情", async () => {
  const tuneweave = new TuneWeaveService({
    config: { api_url: "http://127.0.0.1:12345" },
    async fetch() {
      return Response.json({
        ok: false, error: {
          code: "upstream_error", platform: "soda", message: "do not expose upstream diagnostics",
          details: { upstream_http_status: 200, upstream_response_empty: true, raw: "invented private value" },
        },
      }, { status: 502 })
    },
  })
  const search = await tuneweave.request("/v1/search?platform=soda&q=test").catch(error => error)
  expect(search.message).toContain("汽水签名服务配置")
  expect(search.message).not.toContain("invented private value")
  const media = await tuneweave.request("/v1/tracks/soda%3A1/stream").catch(error => error)
  expect(media.message).toBe("TuneWeave 请求失败：upstream_error")
})

test("QQ 数字、汽水、波点单曲只通过 TuneWeave 读取认证的同 ID 资料", async () => {
  const bodian = "https://h5app.kuwo.cn/m/bodian/playMusic.html?musicId=192015898"
  const mqq = "https://i2.y.qq.com/n3/other/pages/playsong/index.html?songid=480622732"
  const checks = []
  let wrong = false
  const fixtures = {
    "qq:480622732": { platform: "qq", id: mid, ref: "qq:" + mid, name: "QQ 曲", extensions: { numeric_id: "480622732" } },
    "soda:7430806374525323280": { platform: "soda", id: "7430806374525323280", ref: "soda:7430806374525323280", name: "汽水曲" },
    "kuwo:192015898": { platform: "kuwo", id: "192015898", ref: "kuwo:192015898", name: "波点曲" },
  }
  const api = new MusicService({ tuneweave: new TuneWeaveService({
    config: { api_url: "http://127.0.0.1:12345" },
    async fetch(target, init) {
      const url = new URL(target)
      const ref = decodeURIComponent(url.pathname.split("/").at(-1))
      expect(url.origin).toBe("http://127.0.0.1:12345")
      expect(url.searchParams.size).toBe(0)
      expect(new Headers(init.headers).has("cookie")).toBe(false)
      checks.push(ref)
      const result = fixtures[ref]
      return Response.json({ ok: true, data: wrong ? { ...result, extensions: { numeric_id: "480622731" } } : result })
    },
  }) })
  for (const [link, ref] of [[qq, "qq:480622732"], [mqq, "qq:480622732"], [soda, "soda:7430806374525323280"], [bodian, "kuwo:192015898"]]) {
    const target = await resolveMusicShare(parseMusicShare(link), signal, async () => { throw new Error("不应抓取源页") })
    expect(await api.publicShare(target,signal)).toEqual({ kind: "track", track: fixtures[ref] })
  }
  expect(checks).toEqual(["qq:480622732","qq:480622732","soda:7430806374525323280","kuwo:192015898"])
  wrong = true
  await expect(api.publicShare(parseMusicShare(qq), signal)).rejects.toThrow("身份")
})

test("公开 MV 校验 TuneWeave 详情、媒体授权、时长和对应 CDN", async () => {
  const bodian = "https://h5app.kuwo.cn/m/bodian/play.html?mvId=118987"
  const qqMv = "https://y.qq.com/n/ryqq/mv/013xscuH0xlbie"
  let move = false
  const api = new MusicService({ tuneweave: new TuneWeaveService({
    config: { api_url: "http://127.0.0.1:12345" },
    async fetch(target) {
      const url = new URL(target)
      const ref = decodeURIComponent(url.pathname.split("/")[3])
      expect(url.searchParams.get("kind")).toBe("mv")
      const [platform, id] = ref.split(":")
      const duration_ms = 15000
      if (!url.pathname.endsWith("/stream")) {
        return Response.json({ ok: true, data: { kind: "mv", video: { ref, id, platform, title: "测试 MV", duration_ms } } })
      }
      return Response.json({ ok: true, data: {
        video_ref: ref, format: "mp4", available: true, platform,
        ...(platform === "qq" ? {
          url: "http://opi.stream.tencentmusic.com/small.mp4", duration_ms: move ? 1000 : duration_ms,
          platform_code: 0, extensions: { selected_protocol: "mp4" },
        } : {
          url: move ? "https://kuwo.cn.invalid/test.mp4" : "https://kw-bj.kuwo.cn/test.mp4",
          platform_code: 200, extensions: { kind: "mv", source_track_id: id, authorization_source: "current_metadata_and_play_url" },
        }),
      } })
    },
  }) })
  for (const [link, cdn] of [[bodian,"kuwo-mv"],[qqMv,"qq-mv"]]) {
    const { mv } = await api.publicShare(parseMusicShare(link),signal)
    const stream = await api.publicMvStream(mv, signal)
    expect(stream.cdn).toBe(cdn)
    expect(stream.url.protocol).toBe("https:")
    move = true
    await expect(api.publicMvStream(mv, signal)).rejects.toThrow("完整公开 MV")
    move = false
  }
})

test("MV CDN 返回部分内容时不生成可发送的 MP4", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-share-mv-"))
  try {
    const prefix = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from("ftypisomtest")])
    await expect(downloadMedia("https://opi.stream.tencentmusic.com/small.mp4", join(directory, "video"), {
      kind: "video", cdn: "qq-mv", maxBytes: 1024, fetch: async () => new Response(prefix, {
        status: 206, headers: { "Content-Range": "bytes 0-15/32" },
      }),
    })).rejects.toThrow("HTTP 206")
    expect(await readdir(directory)).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("酷狗官方 MV 页校验分享码、同编号、足长和授权的资源哈希", async () => {
  const link = "https://www.kugou.com/mvweb/html/mv_2ir1f4/"
  const html = new Response('<script>var mv_id = "117613"; var encode_mvid = "2ir1f4";</script>')
  const target = await resolveMusicShare(parseMusicShare(link), signal, async (url, options) => {
    expect(url.href).toBe(link)
    expect(options).toMatchObject({ credentials: "omit", redirect: "error" })
    return html
  })
  expect(target).toEqual({ platform: "kugou", kind: "mv", id: "117613", url: link })
  await expect(resolveMusicShare(parseMusicShare(link), signal, async () =>
    new Response('var mv_id = "117613"; var encode_mvid = "another";'))).rejects.toThrow("MV 编号")

  const hash = "9DC24F0A2633F6E451389549B9C5EE87"
  const ref = "kugou:mv:117613"
  const primary = "https://mvwebfs.tx.kugou.com/" + hash.toLowerCase() + ".mp4"
  const backup = primary.replace(".tx.", ".ali.")
  let paid = false
  const api = new MusicService({ tuneweave: new TuneWeaveService({
    config: { api_url: "http://127.0.0.1:12345" },
    async fetch(target) {
      const url = new URL(target)
      expect(decodeURIComponent(url.pathname).startsWith("/v1/videos/" + ref)).toBe(true)
      if (!url.pathname.endsWith("/stream")) {
        return Response.json({ ok: true, data: { kind: "mv",
          video: { ref, id: "117613", platform: "kugou", title: "晴天", duration_ms: 317400 } } })
      }
      return Response.json({ ok: true, data: {
        video_ref: ref, available: true, platform: "kugou",
        url: primary, backup_urls: [primary, backup.replace(hash.toLowerCase(), "b".repeat(32)), backup, backup],
        duration_ms: 317400,
        platform_code: 0, extensions: { kind: "mv", backend: "anonymous_video_tracker",
          selected_resource: { hash, pay_type: paid ? 1 : 0, privilege: 0 } },
      } })
    },
  }) })
  const { mv } = await api.publicShare(target, signal)
  const stream = await api.publicMvStream(mv, signal)
  expect(stream.cdn).toBe("kugou-mv")
  expect(stream.urls).toEqual([primary, backup])
  expect(stream.matchesUrl(new URL(backup))).toBe(true)
  expect(stream.matchesUrl(new URL(backup.replace(hash.toLowerCase(), "b".repeat(32))))).toBe(false)
  paid = true
  await expect(api.publicMvStream(mv, signal)).rejects.toThrow("完整公开 MV")
})

test("实际媒体分发回官方元数据和曲目链接，显式播放提示原平台，未请求备用音源", async () => {
  const module = createMusicCommands({
    signal,
    openMusic: async () => ({ api: {}, timeoutMs: 60000 }),
    fetchMusicShare: async url => {
      expect(url.hostname).toBe("itunes.apple.com")
      return Response.json({ results: [{ trackId: 1468323724, wrapperType: "track", kind: "song", trackName: "hectopascal" }] })
    },
    renderMusicShare: async model => {
      expect(model).toMatchObject({ title: "hectopascal", subtitle: "Apple Music" })
      return new Uint8Array([1])
    },
  })
  const event = { message_type: "group", self_id: 1, group_id: 2, user_id: 3, reply() { return true } }
  expect(await module.fallback(apple, event)).toEqual([{ type: "image", file: new Uint8Array([1]) }, apple])
  expect(await module.fallback("#播放 " + apple, event)).toBe("请在原平台打开并播放。\n" + apple)
})
