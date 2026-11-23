import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDouyinCommands } from "../services/douyin/command.ts"
import { requestText } from "../services/douyin/http.ts"
import { extractDouyinTarget, resolveDouyinShare, targetFromUrl } from "../services/douyin/links.ts"
import { normalizeDouyinWork } from "../services/douyin/model.ts"
import { DouyinService } from "../services/douyin/service.ts"
import { fetchSsrDetail } from "../services/douyin/ssr.ts"

const id = "7656832159801511209"
const other = "7681200077788977514"
const archive = "https://www.douyin.com/video/" + id
const short = "https://v.douyin.com/fixture/?item_id=" + other
const cover = "https://fixture.douyinpic.com/image.png"
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7LQMcAAAAASUVORK5CYII=", "base64")
const config = douyin => ({ douyin: { enable: true, ...douyin }, permissions: {} })
const peer = overrides => ({ message_type: "private", self_id: 9, user_id: 42, reply: async () => true, ...overrides })

test("抖音分享只提取实际作品或短链，并核实短链落点", async () => {
  const outside = "https://example.test/?target=" + archive
  expect(extractDouyinTarget(outside)).toBe("")
  expect(extractDouyinTarget(outside + " " + archive)).toBe(archive)
  expect(extractDouyinTarget("https://www.douyin.com/")).toBe("")
  expect(extractDouyinTarget("https://www.douyin.com/user/foo?modal_id=" + id)).toContain(id)
  expect(targetFromUrl("https://www.douyin.com/?modal_id=" + id + "&item_id=" + other)).toBeNull()
  expect(targetFromUrl("https://www.douyin.com/video/0")).toBeNull()
  expect(extractDouyinTarget('<msg url="' + archive + '?from=a&amp;foo=b"></msg>')).toBe(archive + "?from=a&foo=b")
  expect(targetFromUrl(short)).toBeNull()
  const calls = []
  const final = await resolveDouyinShare(short, { async fetch(input, options) {
    calls.push(input)
    expect(options.redirect).toBe("manual")
    expect(options.credentials).toBe("omit")
    return Response.redirect(archive)
  } })
  expect(final).toEqual({ kind: "work", target: { id, type: "video", url: archive } })
  expect(calls).toEqual([short])
  const commands = createDouyinCommands({}, { loadConfig: async () => { throw new Error("未命中时不能读配置") } })
  try {
    expect(await commands.fallback(outside, peer())).toBeUndefined()
    expect(commands.features(peer({ normalizedMessage: outside }))).toEqual([])
  } finally { await commands.dispose() }
})

test("抖音包体超限、超时及会话取消都会结束读流", async () => {
  const cancelled = []
  const response = (label, headers) => new Response(new ReadableStream({ cancel() { cancelled.push(label) } }), { headers })
  await expect(requestText(async () => response("length", { "content-length": "42" }), archive, {},
    { maxBytes: 20 })).rejects.toMatchObject({ code: "response_too_large" })
  await expect(requestText(async () => response("timeout"), archive, {}, { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" })
  const lease = new AbortController()
  const entered = Promise.withResolvers()
  const stop = new Error("fixture lease ended")
  const pending = requestText(async () => { entered.resolve(); return response("lease") },
    archive, { signal: lease.signal }, { timeoutMs: 1000 })
  await entered.promise
  await Promise.resolve()
  lease.abort(stop)
  await expect(pending).rejects.toBe(stop)
  expect(cancelled).toEqual(["length", "timeout", "lease"])
})

test("抖音公开分享页只跟同稿件站内重定向", async () => {
  const body = `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: {
    entry: { videoInfoRes: { item_list: [{ aweme_id: id, desc: "公开样本" }] } },
  } })}</script>`
  const make = (location, calls) => ({ async fetch(input, options) {
    calls.push(input)
    expect(options.redirect).toBe("manual")
    expect(options.credentials).toBe("omit")
    expect(new Headers(options.headers).has("Cookie")).toBe(false)
    return calls.length === 1 ? Response.redirect(location) : new Response(body)
  } })
  const initial = "https://www.iesdouyin.com/share/video/" + id + "/"
  const accepted = []
  await expect(fetchSsrDetail(id, make(archive, accepted))).resolves.toMatchObject({ aweme_id: id, desc: "公开样本" })
  expect(accepted).toEqual([initial, archive])
  for (const [redirect, reason] of [["https://example.test/", "域名"], [archive.replace(id, other), "其他作品"]]) {
    const calls = []
    await expect(fetchSsrDetail(id, make(redirect, calls))).rejects.toThrow(reason)
    expect(calls).toEqual([initial])
  }
})

test.each(["group", "private"])("抖音 %s 通道撤销后停止媒体读流、清理文件和消息", async message_type => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-douyin-peer-"))
  const connection = new AbortController()
  const pending = Promise.withResolvers()
  const calls = [], replies = []
  let stopped = 0
  const service = new DouyinService({ tasksDir: directory, async fetch(input, options) {
    calls.push(input)
    expect(options.signal.aborted).toBe(false)
    return new Response(new ReadableStream({
      pull() { pending.resolve() },
      cancel() { stopped++ },
    }))
  } })
  service.getInfo = async () => normalizeDouyinWork({ aweme_id: id, desc: "撤销", images: [{ url_list: [cover] }] })
  const commands = createDouyinCommands({}, { makeService: () => service, loadConfig: async () => config() })
  const event = peer({ message_type, group_id: 77, reply: async value => { replies.push(value); return true },
    [message_type === "group" ? "groupActivitySignal" : "privateCredentialSignal"]: connection.signal })
  const request = commands.fallback("#抖音下载 " + archive, event)
  try {
    await pending.promise
    connection.abort()
    expect(await request).toEqual([])
    expect(stopped).toBe(1)
    expect(calls).toEqual([cover])
    expect(replies).toEqual([])
    expect(await readdir(directory)).toEqual([])
  } finally { await commands.dispose(); await request; await rm(directory, { recursive: true, force: true }) }
})

test("首卡或单页绘制失败时仍逐页交付文章，单页超限可降倍数", async () => {
  const service = new DouyinService({ fetch: async () => { throw new Error("无下载请求") } })
  const requests = []
  service.getInfo = async target => {
    requests.push(target.id)
    return normalizeDouyinWork({
    aweme_id:id, aweme_type:163, author:{nickname:"合成作者"}, article_info:{
      article_title:"合成文章", article_content:JSON.stringify({ markdown:"正文\n\n![图](" + cover + ")\n\n后文" }),
    },
    })
  }
  const replies = [], rendered = []
  let enabled = true
  const commands = createDouyinCommands({}, { makeService: () => service, loadConfig: async () => config({ enable: enabled, download: { enable: false } }),
    async render(template, data, { renderScale }) {
      rendered.push([template, data.page, renderScale])
      if (template === "douyin-info" || data.page === 2) throw new Error("合成绘制失败")
      if (data.page === 3 && renderScale !== 2) return Buffer.alloc(32)
      return Buffer.from("image:" + data.page)
    } })
  try {
    const event = peer({ inlineImageByteLimit:16, reply: async value => { replies.push(value); return true } })
    expect(await commands.fallback("#抖音下载", event)).toContain("链接")
    expect(await commands.fallback(archive, event)).toEqual([])
    expect(rendered).toEqual([["douyin-info",undefined,undefined],["article",1,undefined],
      ["article",2,undefined],["article",3,undefined],["article",3,2]])
    expect(replies[0]).toContain("作者：合成作者")
    expect(replies.slice(1)).toEqual([{type:"image", file:Buffer.from("image:1")},cover,{type:"image", file:Buffer.from("image:3")}])
    expect(await commands.fallback("#抖音下视频 " + archive, event)).toEqual([])
    expect(replies.at(-1)).toContain("抖音下载未启用")
    expect(requests).toEqual([id])
    enabled = false
    expect(await commands.fallback(archive, event)).toBeUndefined()
    expect(await commands.fallback("#抖音下载 " + archive, event)).toContain("抖音解析已关闭")
  } finally { await commands.dispose() }
})

test("抖音未知交付明确提示核对，清理任务且不续发其余文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-douyin-delivery-"))
  const service = new DouyinService({ tasksDir: directory, async fetch() { return new Response(png) } })
  service.getInfo = async () => normalizeDouyinWork({ aweme_id:id, desc:"交付",
    images:[{ url_list:[cover] },{ url_list:[cover + "?part=2"] }] })
  const sends = [], replies = []
  const commands = createDouyinCommands({}, { makeService: () => service,
    loadConfig: async () => config({ download: { multi_page_policy:"all" } }) })
  try {
    const event = peer({ inlineImageByteLimit:1, async deliverMedia(result) { sends.push(result.name); return "unknown" },
      async reply(value) { replies.push(value); return true } })
    expect(await commands.fallback("#抖音下载 " + archive, event)).toEqual([])
    expect(sends).toEqual(["001-image.png"])
    expect(replies).toEqual(["[media] 媒体发送结果未确认，请在会话中核对。"])
    expect(await readdir(directory)).toEqual([])
  } finally { await commands.dispose(); await rm(directory, { recursive:true, force:true }) }
})

test("撤销一个抖音消息等待时保留同时使用匿名会话的另一个请求", async () => {
  const visitor = Promise.withResolvers()
  const first = new AbortController()
  const asked = []
  const service = new DouyinService({
    visitor: { get: () => visitor.promise },
    sign: () => "synthetic",
    async fetch(input) {
      asked.push(new URL(input).searchParams.get("aweme_id"))
      return Response.json({ status_code:0, aweme_detail:{ aweme_id:other, images:[{ url_list:[cover] }] } })
    },
  })
  const stale = service.getInfo({ id }, { signal:first.signal })
  const current = service.getInfo({ id:other })
  first.abort()
  await expect(stale).rejects.toBe(first.signal.reason)
  expect(asked).toEqual([])
  visitor.resolve("fixture")
  await expect(current).resolves.toMatchObject({ id:other })
  expect(asked).toEqual([other])
})
