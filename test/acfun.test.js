import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAcfunCommands } from "../services/acfun/command.ts"
import { acfunPlaylist, exactAcfunTarget, sharedAcfunTarget } from "../services/acfun/source.ts"

const id = "48976163"
const canonical = "https://www.acfun.cn/v/ac" + id
const mobile = "https://m.acfun.cn/v/?ac=" + id + "&sid=share"
const cover = "https://tx-free-imgs.acfun.cn/picture.png"
const playlist = "https://tx-safety-video.acfun.cn/test.m3u8"
const web = "https://ali-safety-video.acfun.cn/part.ts"
const segment = "https://tx-safety-video.acfun.cn/part.ts"
const manifest = uri => "#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.0,\n" + uri + "\n#EXT-X-ENDLIST\n"
const enabled = { enable: true, privatePreview: false, permissions: {} }
const group = { message_type: "group", group_id: 77, user_id: 123, self_id: 234, message_id: 1, reply: async () => false }
const mediaData = () => ({
  dougaId: Number(id), title: '作品 {含符号} "内容"', user: { name: "作者" }, description: "详细介绍",
  createTimeMillis: 1794211200000, durationMillis: 5000, coverUrl: cover, viewCount: 100, bananaCount: 5,
  currentVideoInfo: { ksPlayJson: JSON.stringify({ adaptationSet: [{ representation: [
    { url: playlist, qualityLabel: "360P", width: 360, height: 540 },
  ] }] }) },
})
const page = data => new Response("<script>window.pageInfo = window.videoInfo = " + JSON.stringify(data) +
  ";\n window.videoResource = {};</script>")

test("AcFun 识别旧裸号、桌面、手机分享和卡片链接，对无关自然文字保持不匹配", () => {
  for (const value of ["ac" + id, "AC" + id, canonical, mobile]) expect(exactAcfunTarget(value)).toEqual({ id })
  expect(exactAcfunTarget(canonical + "_2")).toEqual({ id, part: 2 })
  for (const value of ["请看(" + canonical + ")", '{"app":"com.tencent","url":"' + mobile.replaceAll("&", "&amp;") + '"}']) {
    expect(sharedAcfunTarget(value)).toEqual({ id })
  }
  for (const value of ["视频 ac" + id, canonical.replace("acfun.cn", "acfun.cn.example.test"), canonical.replace("www.", "x@www."),
    canonical.replace("www.", "www.x."), "https://external.invalid/?url=" + canonical, mobile + "&ac=48976164",
    canonical + "7a", canonical + "/extra", "https://m.acfun.cn/?ac=" + id, "ftp://" + canonical.slice(8)]) {
    expect(sharedAcfunTarget(value)).toBeUndefined()
  }
})

test("AcFun 只预览同号公开信息，群开关、私聊和其他指令边界先于请求", async () => {
  const seen = []
  const models = []
  let data = mediaData()
  let settings = enabled
  const command = createAcfunCommands({}, {
    loadConfig: async () => settings,
    fetch: async (url, init) => {
      seen.push(url)
      expect(init).toMatchObject({ credentials: "omit", redirect: "error" })
      return page(data)
    },
    render: async (template, model) => { models.push([template, model]); return new Uint8Array([1, 2]) },
  })
  const flags = message => command.features({ ...group, normalizedMessage: message })
  expect(flags("#播放 周杰伦")).toEqual([])
  expect(flags("#查询 " + canonical)).toEqual([])
  expect(flags("https://www.acfun.cn/a/ac" + id)).toEqual([])
  expect(flags("分享：" + mobile)).toEqual(["[media] AcFun 解析"])
  try {
    const actual = await command.fallback("分享：" + mobile, group)
    expect(actual).toEqual([{ type: "image", file: new Uint8Array([1, 2]) }, "播放：#播放 " + canonical])
    expect(seen).toEqual([canonical])
    expect(models[0]).toMatchObject(["acfun-info", { title: data.title, owner: "作者", cover, sources: [{ quality: "360P", width: 360, height: 540 }] }])
    expect(await command.fallback(canonical, { ...group, message_type: "private" })).toBeUndefined()
    expect(await command.fallback("#播放 " + canonical, { ...group, isDelegated: true })).toBeUndefined()
    expect(await command.fallback("#播放 " + canonical, { ...group, message_type: "terminal" })).toBeUndefined()
    settings = { ...enabled, enable: false }
    expect(await command.fallback(canonical, group)).toBeUndefined()
    expect(await command.fallback("#播放 " + canonical, group)).toContain("未启用")
    settings = { ...enabled, permissions: { scopes: { "acfun.preview": { policy: "deny" } } } }
    expect(await command.fallback(canonical, group)).toBeUndefined()
    expect(seen).toHaveLength(1)
    settings = { ...enabled, privatePreview: true }
    expect(await command.fallback(canonical, { ...group, message_type: "private" })).toEqual(actual)
    data = { ...data, dougaId: 48976164 }
    expect(await command.fallback(canonical, group)).toContain("无法读取")
    expect(models).toHaveLength(2)
  } finally { await command.dispose() }
})

test("AcFun 播放只接受完整公开 HLS，恶意域、密钥、跨域重定向和分片范围被拒绝", async () => {
  const signal = new AbortController().signal
  const fetch = async (_url, init) => {
    expect(init).toMatchObject({ credentials: "omit", redirect: "manual" })
    return new Response(manifest("part.ts"))
  }
  expect(await acfunPlaylist(playlist, fetch, signal)).toEqual([segment])
  expect(await acfunPlaylist(playlist, async url => url === playlist
    ? Response.redirect("https://ali-safety-video.acfun.cn/mirror.m3u8")
    : new Response(manifest(web)), signal)).toEqual([web])
  for (const body of [
    manifest("https://bad.invalid/part.ts"), manifest("https://tx-safety-video.acfun.cn.bad.invalid/part.ts"),
    manifest("https://u@tx-safety-video.acfun.cn/part.ts"), manifest("https://tx-safety-video.acfun.cn:2000/part.ts"),
    manifest("part.ts#hash"), manifest("segment.mp4"), manifest("part.ts").replace("#EXT-X-ENDLIST", ""),
    manifest("part.ts").replace("#EXTINF", '#EXT-X-KEY:METHOD=AES-128,URI="part.key"\n#EXTINF'),
    manifest("part.ts").replace("part.ts", "#EXT-X-BYTERANGE:20@0\npart.ts"),
    manifest("part.ts").replace("#EXTINF:5.0,", "#EXTINF:3600.1,"),
  ]) await expect(acfunPlaylist(playlist, async () => new Response(body), signal)).rejects.toThrow()
  const calls = []
  await expect(acfunPlaylist(playlist, async url => {
    calls.push(url)
    return Response.redirect("https://somewhere.invalid/redirect.m3u8")
  }, signal)).rejects.toThrow()
  expect(calls).toEqual([playlist])
})

test("AcFun 显式播放逐片合并、清理任务并按原会话回执去重", async () => {
  const tasksDir = await mkdtemp(join(tmpdir(), "lotus-acfun-play-"))
  const video = Bun.spawnSync(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32",
    "-t", "0.23", "-c:v", "libx264", "-f", "mpegts", "pipe:1"])
  expect(video.exitCode).toBe(0)
  const requests = [], sent = [], byteFallback = []
  let result = "unknown"
  let target = "part.ts"
  let segmentStatus = 200
  const partTwo = canonical + "_2"
  let wrongPart = false
  const command = createAcfunCommands({}, {
    tasksDir, loadConfig: async () => enabled,
    async fetch(url, init) {
      requests.push(url)
      expect(init.credentials).toBe("omit")
      expect(new Headers(init.headers).has("cookie")).toBe(false)
      if (url === canonical) return page(mediaData())
      if (url === partTwo) {
        const data = mediaData()
        return page({ ...data, currentVideoId: wrongPart ? 91 : 92, videoList: [{ id: 91 }, { id: 92 }],
          currentVideoInfo: { ...data.currentVideoInfo, id: 92, priority: 1, durationMillis: 5000 } })
      }
      if (url === playlist) return new Response(manifest(target))
      if (url === segment) return new Response(video.stdout, { status: segmentStatus })
      throw new Error("意外请求 " + url)
    },
  })
  const play = "#播放 " + mobile
  const context = { ...group, reply: async value => { byteFallback.push(value); return true },
    async deliverMedia({ type, name, path }) {
      expect(type).toBe("video")
      expect(name).toBe('作品 {含符号} 内容.mp4')
      expect(Buffer.from(await Bun.file(path).bytes()).toString("ascii", 4, 8)).toBe("ftyp")
      sent.push(path)
      return result
    },
  }
  try {
    expect(await command.fallback(play, context)).toContain("送达未确认")
    expect(await command.fallback(play, context)).toEqual([])
    expect(requests).toEqual([canonical, playlist, segment])
    expect(sent).toHaveLength(1)
    expect(byteFallback).toEqual([])
    expect(await readdir(tasksDir)).toEqual([])
    result = "confirmed"
    expect(await command.fallback(play, { ...context, adapter: "milky" })).toEqual([])
    expect(sent).toHaveLength(2)
    target = "https://bad.invalid/part.ts"
    expect(await command.fallback(play, { ...context, message_id: 3 })).toContain("无法播放")
    expect(requests.slice(-2)).toEqual([canonical, playlist])
    const controller = new AbortController()
    controller.abort()
    expect(await command.fallback(play, { ...context, message_id: 4, groupActivitySignal: controller.signal })).toEqual([])
    target = "part.ts"
    segmentStatus = 206
    expect(await command.fallback(play, { ...context, message_id: 5 })).toContain("无法播放")
    expect(await readdir(tasksDir)).toEqual([])
    expect(sent).toHaveLength(2)
    segmentStatus = 200
    expect(await command.fallback("#播放 " + partTwo, { ...context, message_id: 6 })).toEqual([])
    expect(requests.slice(-3)).toEqual([partTwo, playlist, segment])
    wrongPart = true
    expect(await command.fallback("#播放 " + partTwo, { ...context, message_id: 7 })).toContain("无法播放")
    expect(requests.at(-1)).toBe(partTwo)
    expect(sent).toHaveLength(3)
  } finally {
    await command.dispose()
    await rm(tasksDir, { recursive: true, force: true })
  }
})
