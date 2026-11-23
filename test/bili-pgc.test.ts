import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { CommandRegistry } from "../../../lib/commands.ts"
import type { MessageEvent } from "../../../lib/messages.ts"
import { lockFile } from "../../../lib/file-lock.ts"
import { createModule } from "../index.ts"
import { supportGuoba } from "../guoba-settings.ts"
import { playbackQuality, publicBiliPgcTracks } from "../services/bilibili/pgc-playback.ts"
import { fetchBiliPgc, loadBiliPgcSettings, parseBiliPgcLink, parseBiliPgcResponse, type BiliPgcFetch } from "../services/bilibili/pgc.ts"
import { createSubscriptionConfig } from "../services/subscriptions/config.ts"

const episode = "https://www.bilibili.com/bangumi/play/ep2395158"
const season = "https://www.bilibili.com/bangumi/play/ss120817"
const sample = {
  code: 0, result: {
    season_id: 120817, title: "国创动画作品发布会", evaluate: "同一季度简介",
    cover: "http://i0.hdslb.com/bfs/bangumi/season.jpg", rating: { score: 9.9, count: 77 },
    new_ep: { desc: "已更新", title: "发布会" }, stat: { likes: 1, reply: 2, favorite: 3, coins: 4, views: 5, danmakus: 6 },
    episodes: [{ id: 2383667, ep_id: 2383667, title: "1", long_title: "全程回顾", cid: 42 }],
    section: [{ episodes: [
      { id: 2395158, ep_id: 2395158, cid: 34019541653, title: "【山新】", long_title: "带你看前瞻",
        link: episode, cover: "http://i1.hdslb.com/bfs/archive/selected.jpg", duration: 110000, badge: "会员", status: 13 },
    ] }],
  },
}
const groupEvent = (msg: string): MessageEvent => ({
  msg, raw_message: msg, message: [], message_type: "group", post_type: "message", isGroup: true, isPrivate: false,
  isMaster: false, user_id: 12345, self_id: 42, group_id: 800, async reply() { return true },
})

test("番剧公开端点返回同一季及目标分集，番外不会被主列表第一集替代", async () => {
  const signal = new AbortController().signal
  const requests: URL[] = []
  const fetcher: BiliPgcFetch = async (url, options) => {
    requests.push(url)
    expect(options).toMatchObject({ credentials: "omit", redirect: "error",
      headers: { Referer: url.searchParams.has("ep_id") ? episode : season },
    })
    return Response.json(sample)
  }
  expect(await fetchBiliPgc(parseBiliPgcLink(episode)!, fetcher, signal)).toMatchObject({ id: "120817", episode: {
    id: "2395158", cid: "34019541653", title: "【山新】 · 带你看前瞻", badge: "会员", duration: 110,
  } })
  expect(await fetchBiliPgc(parseBiliPgcLink(season)!, fetcher, signal)).toMatchObject({ id: "120817",
    title: "国创动画作品发布会", episode: { id: "2383667", title: "第 1 集 · 全程回顾" } })
  expect(requests.map(url => url.href)).toEqual([
    "https://api.bilibili.com/pgc/view/web/season?ep_id=2395158",
    "https://api.bilibili.com/pgc/view/web/season?season_id=120817",
  ])
  expect(parseBiliPgcResponse(sample, parseBiliPgcLink(episode.replace("2395158", "99999"))!)).toBeUndefined()
  expect(parseBiliPgcResponse(sample, parseBiliPgcLink(season.replace("120817", "99999"))!)).toBeUndefined()
  expect(parseBiliPgcResponse({ ...sample, code: -404 }, parseBiliPgcLink(episode)!)).toBeUndefined()
  for (const value of ["https://www.bilibili.com.evil.test/bangumi/play/ep2395158", episode + "/2",
    "https://www.bilibili.com@evil.test/bangumi/play/ep2395158", "https://www.bilibili.com:8443/bangumi/play/ep2395158"]) {
    expect(parseBiliPgcLink(value)).toBeUndefined()
  }
})

test("番剧由 Media 先识别，权限及关闭开关不落到普通视频，附原文并拒绝错集", async () => {
  let enabled = true, count = 0, body: unknown = sample
  const control = new AbortController()
  const module = await createModule({ lockFile, signal: control.signal,
    biliPgc: {
      options: async () => ({ enable: enabled, private: false, automatic: false, quality: 32, duration: 1800 }),
      fetcher: async () => { count++; return Response.json(body) },
      render: async (name, data) => {
        expect(name).toBe("bilibili-info")
        expect(data).toMatchObject({ id: "ep2395158 · 全季统计", title: "国创动画作品发布会",
          desc: expect.stringContaining("平台标记 · 会员"), cover: "https://i1.hdslb.com/bfs/archive/selected.jpg" })
        return Buffer.from("image")
      },
    },
  })
  const commands = new CommandRegistry()
  commands.registerModule({ name: "@lotus-yunzai/media", ...module })
  const event = groupEvent(episode)
  const dispatch = (input = event, block?: string) => commands.dispatchFallback(input, names => !block || !names.includes(block), () => false)
  try {
    expect(await dispatch(event, "[media] B 站解析")).toBeUndefined()
    enabled = false
    expect(await dispatch()).toBeUndefined()
    enabled = true
    expect(await dispatch({ ...event, message_type: "private", isGroup: false, isPrivate: true })).toBeUndefined()
    expect(count).toBe(0)
    const share = { type: "json", data: JSON.stringify({ jumpUrl: episode }) } as const
    expect(await dispatch({ ...event, msg: "", raw_message: "", message: [share] })).toEqual([
      { type: "image", file: Buffer.from("image") }, { type: "text", text: episode },
    ])
    body = { ...sample, result: { ...sample.result, section: [] } }
    expect(await dispatch()).toBe("暂无法读取 B 站番剧公开信息。\n" + episode)
    expect(count).toBe(2)
  } finally {
    control.abort()
    await module.dispose()
  }
})

test("番剧使用现有 B 站视频链接面板开关和旧 R 的私聊、禁用规则", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-bili-pgc-settings-"))
  const root = pathToFileURL(directory + "/")
  const source = join(directory, "backup/plugins/rconsole-plugin/config")
  const store = createSubscriptionConfig(join(directory, "data"), lockFile)
  try {
    expect(await loadBiliPgcSettings(root, store.settings)).toEqual({ enable: true, private: false, automatic: false, quality: 32, duration: 1800 })
    await mkdir(source, { recursive: true })
    await writeFile(join(source, "tools.yaml"), "globalBlackList: [哔哩哔哩]\nprivateResolve: true\n")
    expect(await loadBiliPgcSettings(root, store.settings)).toEqual({ enable: false, private: true, automatic: false, quality: 32, duration: 1800 })
    await writeFile(join(source, "tools.yaml"), "globalBlackList: []\nprivateResolve: true\n")
    await store.editSettings("bilibili", () => ({ parseVideoLink: 0 }))
    expect(await loadBiliPgcSettings(root, store.settings)).toEqual({ enable: false, private: true, automatic: false, quality: 32, duration: 1800 })
    await writeFile(join(source, "tools.yaml"), "privateResolve: true\nbiliBangumiDirect: true\nbiliBangumiResolution: 5\nbiliBangumiDuration: 999\n")
    const panel = supportGuoba(join(directory, "data"), undefined, root).configInfo
    expect(await panel.getConfigData()).toMatchObject({ bilibili: { biliPgcAuto: true, biliPgcQuality: 112, biliPgcDuration: 999 } })
    const context = { Result: { ok: () => true, error: () => false } }
    expect(await panel.setConfigData({ "bilibili.biliPgcAuto": false, "bilibili.biliPgcQuality": 64, "bilibili.biliPgcDuration": 120 },
      context)).toBe(true)
    expect(await loadBiliPgcSettings(root, store.settings)).toEqual({ enable: false, private: true, automatic: false, quality: 64, duration: 120 })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("分集播放器拒绝试看、付款、加密、未知权限或同 CID 之外的轨道", () => {
  const data = parseBiliPgcResponse(sample, parseBiliPgcLink(episode)!)!
  const cid = data.episode!.cid!
  const track = (type: "audio" | "video", id: number, url = `https://upos-test.bilivideo.com/upgcxcode/53/16/${cid}/${cid}_p1-1-30216.m4s`) => ({
    id, codecid: type === "video" ? 7 : 0, mimeType: `${type}/mp4`, codecs: type === "video" ? "avc1.64001F" : "mp4a.40.2",
    size: 11231, md5: "0123456789abcdef0123456789abcdef", baseUrl: url,
  })
  const result = { code: 0, error_code: 0, can_watch_reason: 0, bp: 0, status: 2, has_paid: false, is_drm: false,
    is_preview: 0, timelength: 109781, dash: { video: [track("video", 64), track("video", 32)], audio: [track("audio", 30280)] } }
  const parse = (raw: unknown) => publicBiliPgcTracks({ code: 0, result: raw }, data.episode!, 32)
  expect(playbackQuality(undefined, 5)).toBe(112)
  expect(parse(result)).toMatchObject({ video: { id: 32 }, audio: { id: 30280 }, duration: 109.781 })
  for (const patch of [{ is_preview: 1 }, { error_code: -10403 }, { can_watch_reason: 1 }, { bp: 1 }, { has_paid: true },
    { status: 13 }, { is_drm: true }, { bp: undefined }, { timelength: 1000 },
    { dash: { ...result.dash, audio: [track("audio", 30280, `https://upos-test.bilivideo.com/upgcxcode/53/22/789/789_p1-1-30216.m4s`)] } },
    { dash: { ...result.dash, audio: [track("audio", 30280, `https://upos-test.bilivideo.com.evil.test/upgcxcode/53/16/${cid}/${cid}_p1-1-30216.m4s`)] } },
  ]) expect(parse({ ...result, ...patch })).toBeUndefined()
})

test("新版播放命令和旧 B 站下载形式识别 ep，未有授权不触碰播放器或 CDN", async () => {
  const control = new AbortController()
  const calls: string[] = []
  const module = await createModule({ lockFile, signal: control.signal, biliPgc: {
    options: async () => ({ enable: true, private: false, automatic: false, quality: 32, duration: 1800 }),
    fetcher: async url => { calls.push(url.pathname); return Response.json(sample) },
    playback: { cdnFetch: async () => { throw new Error("不应该触碰媒体 CDN") } },
  } })
  const commands = new CommandRegistry()
  commands.registerModule({ name: "@lotus-yunzai/media", ...module })
  try {
    for (const prefix of ["#播放 ", "#B站下载 "]) {
      const result = await commands.dispatchFallback(groupEvent(prefix + episode), () => true, () => false)
      expect(result).toMatch(/未提供可验证的公开下载权限.*\n.*ep2395158/u)
    }
    expect(calls).toEqual(["/pgc/view/web/season", "/pgc/view/web/season"])
  } finally {
    control.abort()
    await module.dispose()
  }
})

test("B 站短链只展开一次再分流番剧、普通视频、分 P、直播和动态", async () => {
  const control = new AbortController()
  const calls: string[] = []
  const shortEpisode = "https://b23.tv/ep2395158"
  const shortSeason = "https://b23.tv/ss120817"
  const bvid = "BV17x411w7KC"
  const ref = `bilibili:bvid:${bvid}`
  const normal = `https://www.bilibili.com/video/${bvid}`
  const shortNormal = "https://b23.tv/video"
  const shortPart = "https://b23.tv/part"
  const shortLive = "https://b23.tv/live"
  const shortDynamic = "https://b23.tv/dynamic"
  const unsafe = "https://b23.tv/unsafe"
  const destinations = new Map([
    [shortEpisode, episode + "?share_source=test"], [shortSeason, season],
    [shortNormal, normal], [shortPart, normal + "?p=2&share_source=test"],
    [shortLive, "https://live.bilibili.com/800"],
    [shortDynamic, "https://t.bilibili.com/12345"],
    [unsafe, "https://example.com/bangumi/play/ep2395158"],
  ])
  let parseLink = true
  const module = await createModule({ lockFile, signal: control.signal,
    biliVideo: {
      async settings() {
        return { ...(await createSubscriptionConfig(join(tmpdir(), "lotus-pgc-unconfigured"), lockFile).settings("bilibili")),
          parseVideoLink: parseLink }
      },
      async fetch(input, options) {
        const url = new URL(input)
        if (destinations.has(url.href)) {
          expect(options).toMatchObject({ method: "HEAD", redirect: "manual", credentials: "omit" })
          calls.push("HEAD " + url.href)
          return Response.redirect(destinations.get(url.href)!)
        }
        if (url.hostname === "api.live.bilibili.com") {
          calls.push("live " + url.searchParams.get("room_id"))
          return Response.json({ code: 0, data: { title: "直播夹具", live_status: 1 } })
        }
        if (url.pathname === "/x/polymer/web-dynamic/v1/detail") {
          calls.push("dynamic " + url.searchParams.get("id"))
          return Response.json({ code: 0, data: {} })
        }
        calls.push("TuneWeave " + decodeURIComponent(url.pathname))
        const data = url.pathname.endsWith("/parts")
          ? [1, 2].map(page => ({ video_ref: ref, id: "cid:" + page, page, title: "测试分集 " + page }))
          : { video: { ref, title: "普通视频夹具", extensions: { bvid, comment_count: 0 } } }
        return Response.json({ ok: true, data, meta: { platform: "bilibili" } })
      },
    },
    biliPgc: {
      options: async () => ({ enable: true, private: false, automatic: false, quality: 32, duration: 1800 }),
      fetcher: async url => { calls.push(url.search); return Response.json(sample) },
      render: async () => Buffer.from("PGC"),
    },
  })
  const commands = new CommandRegistry()
  commands.registerModule({ name: "@lotus-yunzai/media", ...module })
  const dispatch = (event: MessageEvent, blocked = false) =>
    commands.dispatchFallback(event, names => !blocked || !names.includes("[media] B 站解析"), () => false)
  const quote = (jumpUrl: string) => ({ ...groupEvent("#解析"), reply_id: 8000,
    lookupReply: async () => ({ message_id: 8000, user_id: 12345,
      message: [{ type: "json", data: JSON.stringify({ meta: { news: { jumpUrl } } }) }] }),
  } satisfies MessageEvent)
  const picture = (url: string) => [{ type: "image", file: Buffer.from("PGC") }, { type: "text", text: url }] as const
  try {
    expect(await dispatch(groupEvent(shortEpisode), true)).toBeUndefined()
    expect(await dispatch(groupEvent(episode), true)).toBeUndefined()
    parseLink = false
    expect(await dispatch(groupEvent(shortEpisode))).toBeUndefined()
    expect(calls).toEqual([])
    parseLink = true
    expect(await dispatch(groupEvent(shortEpisode))).toEqual(picture(episode))
    expect(await dispatch(quote(shortSeason))).toEqual(picture(season))
    expect(calls.splice(0)).toEqual(["HEAD " + shortEpisode, "?ep_id=2395158", "HEAD " + shortSeason, "?season_id=120817"])
    for (const short of [shortNormal, shortPart]) {
      await dispatch(quote(short))
      expect(calls.splice(0)).toEqual(["HEAD " + short, "TuneWeave /v1/videos/" + ref, "TuneWeave /v1/videos/" + ref + "/parts"])
    }
    await dispatch(groupEvent(shortLive))
    expect(calls.splice(0)).toEqual(["HEAD " + shortLive, "live 800"])
    expect(await dispatch(groupEvent(shortDynamic))).toBe("[media] 这条 B 站动态不可用。")
    expect(calls.splice(0)).toEqual(["HEAD " + shortDynamic, "dynamic 12345"])
    await dispatch(groupEvent(unsafe))
    expect(calls.splice(0)).toEqual(["HEAD " + unsafe])
  } finally {
    control.abort()
    await module.dispose()
  }
})
