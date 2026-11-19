import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BilibiliService } from "../services/bilibili/service.js"
import { extractDouyinTarget, resolveDouyinTarget } from "../services/douyin/links.js"
import { generateABogus } from "../services/douyin/signature.js"
import { normalizeDouyinWork } from "../services/douyin/model.js"
import { fetchCdn } from "../services/media/cdn.js"
import { sendMediaFile } from "../services/media/files.js"
import { articlePages, buildMediaMessageText } from "../services/media/message.js"

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
  await expect(sendMediaFile({...event,deliverMedia:async () => "unknown"},video)).rejects.toThrow("未确认")
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
