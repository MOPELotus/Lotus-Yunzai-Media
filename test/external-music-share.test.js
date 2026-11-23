import { expect, test } from "bun:test"
import { readExternalMusicShare } from "../services/music/external-share.ts"
import { parseMusicShare, resolveMusicShare } from "../services/music/share-link.ts"
import { createMusicCommands } from "../services/music/command.ts"

const apple = "https://music.apple.com/cn/album/hectopascal/1468323115?i=1468323724"
const spotify = "https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8"
const sodaShort = "https://qishui.douyin.com/s/iQfNnBfJ/"
const soda = "https://music.douyin.com/qishui/share/track?track_id=7430806374525323280"
const qq = "https://y.qq.com/n/ryqq_v2/songDetail/480622732"
const mid = "003lfH1n1uKTn4"
const signal = new AbortController().signal
const sodaPage = id => '<script id="modern-inline">_ROUTER_DATA = ' + JSON.stringify({ loaderData: { track_page: {
  audioWithLyricsOption: { track_id: id, trackName: "汽水样本", artistName: "Luke Muzzic", url: "https://audio.invalid/preview" },
} } }) + ";\n</script>"
const qqPage = (canonical, songMids) => '<meta property="og:url" content="' + canonical +
  '"/><script type="application/ld+json">' + JSON.stringify({ "@graph": songMids.map(value => ({
    "@type": "MusicRecording", url: "https://y.qq.com/n/ryqq_v2/songDetail/" + value,
  })) }) + "</script>"

test("三家官方分享元数据逐号验证，屏蔽列表、跨站跳转和恶意地址", async () => {
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
    if (url.href === sodaShort) {
      expect(options.redirect).toBe("manual")
      return Response.redirect(soda + "&sec_sharer_id=ignored")
    }
    expect(url.href).toBe(soda)
    expect(options.redirect).toBe("error")
    return new Response(sodaPage("7430806374525323280"))
  }
  expect(await readExternalMusicShare(parseMusicShare(apple), signal, transport)).toEqual({
    title: "hectopascal", author: "zzz - Anime on Piano", url: apple,
  })
  expect(await readExternalMusicShare(parseMusicShare(spotify), signal, transport)).toEqual({ title: "Never Gonna Give You Up", url: spotify })
  expect(await readExternalMusicShare(parseMusicShare(sodaShort), signal, transport)).toEqual({ title: "汽水样本", author: "Luke Muzzic", url: soda })
  expect(calls).toHaveLength(4)
  await expect(readExternalMusicShare(parseMusicShare(sodaShort), signal, async () =>
    Response.redirect(soda.replace("music.douyin.com", "example.test")))).rejects.toThrow("未指向")
  await expect(readExternalMusicShare(parseMusicShare(soda), signal, async () =>
    new Response(sodaPage("7430806374525323281")))).rejects.toThrow("编号")
})

test("QQ 数字曲目从官方同号页面校验唯一 MID，再走已接的 QQ 单曲身份", async () => {
  for (const url of [qq, "https://i2.y.qq.com/n3/other/pages/playsong/index.html?songid=480622732"]) {
    expect(await resolveMusicShare(parseMusicShare(url), signal, async (actual, options) => {
      expect(actual.href).toBe(qq)
      expect(options).toMatchObject({ credentials: "omit", redirect: "error" })
      return new Response(qqPage(qq, [mid]))
    })).toEqual({ platform: "qq", kind: "track", id: mid, url: "https://y.qq.com/n/ryqq/songDetail/" + mid })
  }
  await expect(resolveMusicShare(parseMusicShare(qq), signal, async () =>
    new Response(qqPage(qq.replace("480622732", "480622733"), [mid])))).rejects.toThrow("原曲目")
  await expect(resolveMusicShare(parseMusicShare(qq), signal, async () =>
    new Response(qqPage(qq, [mid, "004lfH1n1uKTn5"])))).rejects.toThrow("唯一")
})

test("波点旧歌曲和 MV 读取匿名官方详情，按原编号和 MV 标记核实", async () => {
  const share = "https://h5app.kuwo.cn/m/bodian/playMusic.html?uid=3216773&musicId=192015898"
  const mv = "https://h5app.kuwo.cn/m/bodian/play.html?mvId=118987&opusId=770096"
  const checks = []
  const official = async (actual, init) => {
    expect(actual.origin + actual.pathname).toBe("https://bd-api.kuwo.cn/api/service/music/info")
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" })
    expect(init.headers.devId).toMatch(/^[a-f\d]{16}$/u)
    expect(actual.searchParams.get("uid")).toBe("-1")
    const id = Number(actual.searchParams.get("musicId"))
    checks.push(id)
    return Response.json({ code: 200, data: { id, isMv: id === 118987 ? 1 : 0,
      name: id === 118987 ? "枫" : "Forever", artist: id === 118987 ? "周杰伦" : "Dwhite" } })
  }
  expect(await readExternalMusicShare(parseMusicShare(share), signal, official)).toEqual({
    title: "Forever", author: "Dwhite", url: "https://h5app.kuwo.cn/m/bodian/playMusic.html?musicId=192015898",
  })
  expect(await readExternalMusicShare(parseMusicShare(mv), signal, official)).toEqual({
    title: "枫", author: "周杰伦", url: "https://h5app.kuwo.cn/m/bodian/play.html?mvId=118987",
  })
  expect(checks).toEqual([192015898, 118987])
  expect(parseMusicShare(share + "&musicId=2")).toBeUndefined()
  await expect(readExternalMusicShare(parseMusicShare(mv), signal, async () =>
    Response.json({ code: 200, data: { id: 118987, name: "枫", isMv: 0 } }))).rejects.toThrow("编号")
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
