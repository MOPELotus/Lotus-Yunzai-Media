import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { loadGlobalConfig } from "../core/config/global.ts"
import { BilibiliService, formatBilibiliPreviewText } from "../services/bilibili/service.ts"
import { extractDouyinTarget, resolveDouyinTarget } from "../services/douyin/links.ts"
import { generateABogus } from "../services/douyin/signature.ts"
import { normalizeDouyinWork } from "../services/douyin/model.ts"
import { createDouyinCommands } from "../services/douyin/command.ts"
import { DouyinService } from "../services/douyin/service.ts"
import { fetchCdn } from "../services/media/cdn.ts"
import { mediaDeliveryUnknown, sendMediaFile } from "../services/media/files.ts"
import { articlePages, buildMediaMessageText, isMediaCommandText } from "../services/media/message.ts"
import { CommandRegistry } from "../../../lib/commands.ts"

const directories = []
async function fixtureFile(name, bytes = "小文件") {
  const directory = await mkdtemp(join(tmpdir(), "lotus-media-regression-"))
  directories.push(directory)
  const file = join(directory, name)
  await writeFile(file, bytes)
  return file
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

test("宿主卸载抖音命令时中止正在传输的 CDN 下载并清理任务目录", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-douyin-stop-"))
  directories.push(directory)
  const entered = Promise.withResolvers()
  const lifecycle = new AbortController()
  const work = normalizeDouyinWork({ aweme_id: "12345678", desc: "取消测试",
    video: { play_addr: { url_list: ["https://fixture.douyincdn.com/media"] } },
  })
  let requests = 0
  let requestSignal
  const service = new DouyinService({ tasksDir: directory, async fetch(_url, init) {
    requests++
    requestSignal = init.signal
    return new Response(new ReadableStream({
      pull(stream) {
        stream.enqueue(Uint8Array.of(0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109))
        entered.resolve()
        return new Promise(resolve => {
          requestSignal.addEventListener("abort", () => {
            try { stream.error(requestSignal.reason) } catch {}
            resolve()
          }, { once: true })
        })
      },
    }))
  } })
  let lookups = 0
  service.getInfo = async () => { lookups++; return work }
  const module = createDouyinCommands({ signal: lifecycle.signal }, {
    makeService: () => service,
    loadConfig: () => loadGlobalConfig(pathToFileURL(directory + "/")),
  })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "@lotus-yunzai/media", commands: {}, fallback: module.fallback, fallbackFeatures: module.features })
  const messages = []
  const event = { msg: "#抖音下载 https://www.douyin.com/video/12345678", message_type: "private",
    user_id: 42, isMaster: true, reply: text => { messages.push(text); return true } }
  const inFlight = registry.dispatchFallback(event, () => true, () => true)
  try {
    await entered.promise
    await module.dispose()
    expect(requestSignal.aborted).toBe(true)
    expect(await readdir(directory)).toEqual([])
    expect(await inFlight).toEqual([])
    expect(await registry.dispatchFallback(event, () => true, () => true)).toBeUndefined()
    expect([requests, lookups, messages]).toEqual([1, 1, []])
  } finally {
    await module.dispose()
    await inFlight
  }
})

test.each(["transcode", "zip"])("抖音下载在 %s 阶段沿用取消信号，停止时不留下输出或重试", async phase => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-douyin-output-stop-"))
  directories.push(directory)
  const controller = new AbortController()
  const work = normalizeDouyinWork({ aweme_id: "12345678", desc: "取消测试",
    video: { play_addr: { url_list: ["https://fixture.douyincdn.com/media"] } },
  })
  if (phase === "zip") work.media.push({ ...work.media[0], index: 2 })
  const stages = []
  const service = new DouyinService({ tasksDir: directory,
    async fetch() {
      return new Response(Uint8Array.of(0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109))
    },
    async prepareVideo(file, options) {
      stages.push("transcode")
      expect(options.signal).toBe(controller.signal)
      if (phase === "transcode") controller.abort()
      return { file, warnings: [] }
    },
    async pack(_files, target, options) {
      stages.push("zip")
      expect(options.signal).toBe(controller.signal)
      await writeFile(target, "partial output")
      controller.abort()
      return target
    },
  })
  await expect(service.download(work, {}, { signal: controller.signal })).rejects.toThrow()
  expect(await readdir(directory)).toEqual([])
  expect(stages).toEqual(phase === "zip" ? ["transcode", "transcode", "zip"] : ["transcode"])
})

test("自动解析跳过显式媒体命令的参数，仍接受直接分享的链接和编号", () => {
  const bvid = "BV1dAxE6VErW"
  const link = "https://www.bilibili.com/video/" + bvid
  for (const input of ["#搜视频" + bvid, "#看视频 " + link, "#B站下视频 " + bvid,
    "#荷花下载 " + link, "#荷花下视频 " + bvid, "#荷花搜视频" + bvid, "#荷花QQ点歌 " + link]) {
    expect(isMediaCommandText(input)).toBe(true)
  }
  for (const input of [bvid, link, "分享一个视频 " + link, "#周末推荐 " + link]) {
    expect(isMediaCommandText(input)).toBe(false)
  }
})

test("B 站搜索读取旧账号别名，新登录只更新主文件，冲突不选择旧账号", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-bilibili-account-"))
  directories.push(directory)
  const accountFile = join(directory, "account.yaml")
  const first = join(directory, "old.yaml")
  const second = join(directory, "renamed.yaml")
  const original = "# 原格式\r\ntuneweave_account: fixture-old\r\ncookie: fixture-never-forwarded\r\n"
  const conflict = "tuneweave_account: fixture-conflict\n"
  const searched = []
  const tuneweave = { async request(route) {
    const url = new URL(route, "http://127.0.0.1")
    if (url.pathname === "/v1/auth/qr/fixture-login") return { state: "confirmed", profile: { authenticated: true } }
    expect(url.pathname).toBe("/v1/search")
    expect(url.searchParams.has("cookie")).toBe(false)
    searched.push(url.searchParams.get("account"))
    return []
  } }
  const service = () => new BilibiliService({ accountFile, legacyAccountFiles: [first, second], tuneweave })
  await writeFile(first, original)
  await service().search("旧账号")
  expect(await Bun.file(accountFile).exists()).toBe(false)
  await writeFile(second, conflict)
  await expect(service().search("冲突")).rejects.toThrow("旧 B 站账号记录不一致")
  expect(searched).toEqual(["fixture-old"])

  await writeFile(accountFile, "{}")
  await service().search("主文件匿名")
  const renewed = service()
  expect((await renewed.waitQrLogin({ qrcodeKey: "fixture-login" })).ok).toBe(true)
  await service().search("重启后新账号")
  expect(searched).toEqual(["fixture-old", null, "lotus-bilibili"])
  expect((await stat(accountFile)).mode & 0o777).toBe(0o600)
  expect(await readFile(first, "utf8")).toBe(original)
  expect(await readFile(second, "utf8")).toBe(conflict)
})

test("独立 QQ 分享卡优先取得 B 站短链，并只跟随 B 站域名", async () => {
  const requests = []
  const service = new BilibiliService({ fetch: async (url, options) => {
    requests.push([url.href, options.redirect])
    return new Response(null, {status: 302, headers: {location: "https://www.bilibili.com/video/BV1dAxE6VErW"}})
  } })
  const card = JSON.stringify({
    meta: {detail: {preview: "https://www.bilibili.com/video/BV1dAxE6VErX", qqdocurl: "https://b23.tv/test"}}
  })
  const raw = buildMediaMessageText({
    raw_message: `[CQ:json,data=${card}]`,
    message: [{type:"json", data:card}]
  })
  expect(await service.resolveTarget(service.extractTarget(raw))).toEqual({type: "video", bvid: "BV1dAxE6VErW"})
  expect(requests).toEqual([["https://b23.tv/test", "manual"]])
  expect(service.extractTarget(JSON.stringify({url:"https://example.test/bilibili.com/video/BV1dAxE6VErW"}))).toBeNull()
})

test("短链指到站外和抖音 CDN 跨域跳转时停止请求", async () => {
  const requests = []
  const redirect = async (url) => {
    requests.push(String(url))
    return new Response(null, {status:302, headers:{location: "https://example.test/redirect"}})
  }
  const bili = new BilibiliService({ fetch:redirect })
  await expect(bili.resolveTarget("https://b23.tv/out")).rejects.toThrow("未跳转")
  await expect(resolveDouyinTarget("https://v.douyin.com/test/", {fetch:redirect})).rejects.toThrow("链接域名")
  await expect(fetchCdn(redirect,"https://p3.douyinpic.com/test.png",{}, "image")).rejects.toThrow("平台 CDN")
  expect(requests).toEqual(["https://b23.tv/out", "https://v.douyin.com/test/", "https://p3.douyinpic.com/test.png"])
})

test("B 站裸短链可从分享文案与显式目标解析，仍只请求可信短链站点", async () => {
  const requests = []
  const canonical = "https://b23.tv/a1B2c3"
  const bvid = "BV1dAxE6VErW"
  const service = new BilibiliService({ fetch: async (url, options) => {
    requests.push([url.href, options.method, options.redirect])
    return new Response(null, { status:302, headers:{ location:"https://www.bilibili.com/video/" + bvid } })
  } })
  expect(service.extractTarget("视频：【b23.tv/a1B2c3?share_source=copy】，也可搜 " + bvid)).toBe(canonical)
  expect(service.extractTarget("链接（b23.tv/a1B2c3）")).toBe(canonical)
  expect(service.extractTarget("链接 //b23.tv/a1B2c3.")).toBe(canonical)
  expect(await service.resolveTarget("b23.tv/a1B2c3?share_source=copy")).toEqual({ type:"video", bvid })
  expect(await service.resolveTarget("//b23.tv/a1B2c3")).toEqual({ type:"video", bvid })
  for (const invalid of ["https://example.test/b23.tv/a1B2c3", "evil-b23.tv/a1B2c3",
    "http://user@b23.tv/a1B2c3", "b23.tv:8080/a1B2c3", "b23.tv/a1B2c3/path", "b23.tv/a1B2c3.exe"]) {
    expect(service.extractTarget(invalid)).toBe("")
    await expect(service.resolveTarget(invalid)).rejects.toThrow("不支持的 B 站链接")
  }
  expect(requests).toEqual([[canonical, "HEAD", "manual"], [canonical, "HEAD", "manual"]])
})

test("B 站文字预览沿用旧字段和时间顺序，保留零值并省略缺失数据", async () => {
  const bvid = "BV1dAxE6VErW"
  const service = new BilibiliService()
  service.tuneRequest = async route => route.endsWith("/parts") ? [] : { video: {
    ref: "bilibili:bvid:" + bvid,
    title: "<strong>公开稿件</strong>",
    creators: [{ ref: "bilibili:user:42", name: "UP 测试" }],
    duration_ms: 3665000, published_at: "2023-11-14T22:14:20Z",
    description: "公开简介\n第二行", play_count: 11000,
    extensions: { bvid, ctime: 1700000000, copyright: "original", category_name: "音乐",
      category_name_v2: "演奏", danmaku_count: 0, like_count: 8, favorite_count: 0, share_count: 2 },
  } }
  const info = await service.getVideoInfo({ bvid })
  expect(formatBilibiliPreviewText(info)).toBe([
    "公开稿件", "bvid：" + bvid, "分区：演奏 (音乐)", "投稿：2023年11月15日 06:13:20",
    "发布：2023年11月15日 06:14:20", "时长：1:01:05", "创作：原创", "UP主：UP 测试", "UID：42",
    "视频简介：", "公开简介", "第二行", "1.1万播放 • 0弹幕", "8点赞 • 0收藏", "2分享",
    "链接：https://www.bilibili.com/video/" + bvid,
  ].join("\n"))
  expect(formatBilibiliPreviewText({ title: "旧实例", duration: 0, publishedAt: "坏值", stat: { share: -1 } })).toBe("旧实例")
})

test("抖音文章维持正文、图片和后文顺序，统计缺失时维持未记录", () => {
  const id = "7681200077788977514"
  const share = buildMediaMessageText({message:[{type:"light_app",data:{url:`https://www.douyin.com/article/${id}`}}]})
  expect(extractDouyinTarget(share)).toContain(id)
  const work = normalizeDouyinWork({
    aweme_id:id,aweme_type:163,author:{nickname:"作者"},statistics:{digg_count:0},
    article_info:{article_title:"文章",article_content:JSON.stringify({
      markdown: "正文\n\n![图](https://p3.douyinpic.com/a.png)\n\n后文"
    })}
  })
  expect(articlePages(work.article).map(page => page[0].type === "image" ? page[0].urls[0] : page[0].text))
    .toEqual(["正文", "https://p3.douyinpic.com/a.png", "后文"])
  expect(work.stat.like).toBe(0)
  expect(work.stat.reply).toBeUndefined()
})

test("发送保留显示文件名并按视频阈值改用上传，未确认时不重发", async () => {
  const video = await fixtureFile("独立任务.mp4")
  const sent = []
  const event = {
    self_id:99,
    uploadFile: async ({name, bytes}) => { sent.push(["file",name,bytes.toString()]); return "confirmed" },
    reply: async ({type,data}) => { sent.push([type,data.name,data.file.toString()]); return true },
  }
  await sendMediaFile(event,video,{file_name:"作品 15%.mp4"})
  await sendMediaFile(event,video,{file_name:"作品 15%.mp4",video_size_limit_mb:0.000001})
  expect(sent).toEqual([["video","作品 15%.mp4","小文件"],["file","作品 15%.mp4","小文件"]])
  await expect(sendMediaFile({...event,deliverMedia:async () => "unknown"},video)).rejects.toMatchObject({code:mediaDeliveryUnknown})
  expect(sent).toHaveLength(2)
})

test("同一账号的相同媒体发送串行，另一账号没有等待", async () => {
  const first = await fixtureFile("1.mp4")
  const second = await fixtureFile("2.mp4")
  const trace = []
  const started = Promise.withResolvers()
  const block = Promise.withResolvers()
  function event(self_id, note, pause = false) {
    return {self_id,reply:async () => {
      trace.push(note)
      if (pause) { started.resolve(); await block.promise }
      return true
    }}
  }
  const head = sendMediaFile(event(99,"第一份",true),first)
  await started.promise
  const sameBot = sendMediaFile(event(99,"本账号下一份"),second)
  await sendMediaFile(event(42,"另一账号"),second)
  expect(trace).toEqual(["第一份","另一账号"])
  block.resolve()
  await Promise.all([head,sameBot])
  expect(trace).toEqual(["第一份","另一账号","本账号下一份"])
})

test("Bun 中访客签名与原 Node SM3 的固定输入一致", () => {
  const result = generateABogus("aid=6383&aweme_id=7656832159801511209", {now:1780000000000, random:()=>0.25})
  expect(result).toBe("O7U5DzU7dqmfFV/buKGgH73lcenMrB8yrTiOWCFPexzlPq0alSPRMOGwnxoLsg6bdbpkie37/x0MbExcuTX0ZC9kzmpDuQ7WDG5CVgXo/qw4T0JQLqjzewXzow0n0bsq-5VXi1WIhUJo6fxAwqQ8/BAyyKoF55SBB3OWk/YcT9B6ZFyADpnrPdtpqh-u")
})
