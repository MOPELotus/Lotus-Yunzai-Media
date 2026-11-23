import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { CommandRegistry } from "../../../lib/commands.ts"
import { readGroupDispatch } from "../../../lib/group-dispatch.ts"
import { loadPublicShareConfig } from "../core/config/global.ts"
import { supportGuoba } from "../guoba-settings.ts"
import { fetchCdn } from "../services/media/cdn.ts"
import { createWeixinChannelsPreview } from "../services/weixin-channels/preview.ts"

const id = "AzGrUgqzFv"
const share = "https://weixin.qq.com/sph/" + id
const page = "https://channels.weixin.qq.com/finder-preview/pages/sph?id=" + id
const api = "https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info"
const png = Uint8Array.of(1, 2, 3, 4)
const data = {
  sceneInfo: { dynamicExportId: "export/a7890123456789012345" }, errMsg: { type: 0 },
  authorInfo: { nickname: "作者", headImgUrl: "https://wx.qlogo.cn/finderhead/ver_1/avatar/0" },
  feedInfo: { description: "公开分享", isHardAd: false, createtime: 1_780_000_000,
    coverUrl: "http://finder.video.qq.com/251/20234/stodownload?thumb=1", mediaUrl: "https://private.example/video.mp4",
    favCountFmt: "93", likeCountFmt: "1.1万", forwardCountFmt: "166", commentCountFmt: "10" },
}
const publicResult = payload => Response.json({ errCode: 0, data: payload }, { status: 201 })
const group = { normalizedMessage: share, message_type: "group", group_id: 123, user_id: 42, self_id: 77,
  isMaster: false, reply() {} }

test("视频号按原 ID 请求匿名官方预览，使用共同 Skia 信息卡和原链接", async () => {
  const calls = [], cards = []
  const module = createWeixinChannelsPreview({
    async fetch(url, options) {
      calls.push(url)
      expect(options.credentials).toBe("omit")
      expect(options.redirect).toBe("manual")
      if (url === share) return Response.redirect(page)
      expect(url).toBe(api)
      expect(options).toMatchObject({ method: "POST", headers: { Origin: "https://channels.weixin.qq.com", Referer: page } })
      expect(JSON.parse(options.body)).toEqual({ baseReq: { generalToken: "" }, shortUri: id })
      return publicResult(data)
    },
    async render(template, model) { cards.push([template, model]); return png },
  })
  expect(module.features(group)).toEqual(["[media] 视频号分享"])
  expect(await module.fallback(share, group)).toEqual([{ type: "image", file: png }, "在微信中观看\n" + share])
  expect(cards).toEqual([["weixin-channels-info", { id: "视频号", type: "share", title: "公开分享", owner: "作者",
    cover: "https://finder.video.qq.com/251/20234/stodownload?thumb=1", avatar: data.authorInfo.headImgUrl, createdAt: 1_780_000_000,
    stat: { like: "93", favorite: "1.1万", share: "166", reply: "10" } }]])
  expect(calls).toEqual([share, api])
  expect(await module.fallback("#播放 " + share, group)).toBeUndefined()
  expect(await module.fallback(share, { ...group, isDelegated: true })).toBeUndefined()
  expect(await module.fallback(share, { ...group, message_type: "private" })).toBeUndefined()
  expect(calls).toHaveLength(2)
})

test("无描述的公开视频号分享仍提供作者和微信原链接", async () => {
  const module = createWeixinChannelsPreview({
    fetch: async url => url === share ? Response.redirect(page) : publicResult({ ...data,
      feedInfo: { ...data.feedInfo, description: "" },
    }),
    render: async () => { throw Error("no image") },
  })
  expect(await module.fallback(share, group)).toBe("视频号 · 视频号分享\n作者\n在微信中观看\n" + share)
})

test("视频号仅信任同一 ID 的官方路由，拒绝空壳、错误页、推荐与认证响应", async () => {
  const picture = new Response("not fetched")
  let kind = 0
  const module = createWeixinChannelsPreview({ fetch: async url => url === share
    ? [Response.redirect(page.replace(id, "AAAAAAAAAA")), Response.redirect(page),
      Response.redirect(page), Response.redirect(page), Response.redirect(page), new Response("shell")][kind]
    : [
      picture, publicResult({ errMsg: { type: 2 }, recommended: [data] }),
      publicResult({ feedInfo: data.feedInfo, authorInfo: data.authorInfo, errMsg: { type: 0 } }),
      new Response("<title>视频号</title>"), new Response(null, { status: 401 }), picture,
    ][kind], render: async () => { throw Error("unavailable responses should not render") } })
  for (kind = 0; kind < 6; kind++) {
    expect(await module.fallback(share, group)).toBe("暂时无法读取视频号公开预览，请打开原链接。\n" + share)
  }
  expect(module.features({ ...group, normalizedMessage: share.replace("weixin.qq.com", "weixin.qq.com.invalid") })).toEqual([])
  expect(module.features({ ...group, normalizedMessage: page + "&id=AAAAAAAAAA" })).toEqual([])
  await expect(fetchCdn(async () => Response.redirect("https://www.qq.com/video.mp4"),
    "https://finder.video.qq.com/251/123/stodownload", {}, "weixin-channels-image")).rejects.toThrow("预览 CDN")
})

test("视频号面板继承旧黑名单和私聊开关，只写已编辑的值", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-channels-settings-"))
  const root = pathToFileURL(dir + "/")
  const previous = join(dir, "backup/plugins/rconsole-plugin/config")
  const global = join(dir, "config/global.yaml")
  const source = "# 保留\npermissions:\n  scopes:\n    wxchannels.preview: {policy: deny}\n"
  const legacy = "globalBlackList: [视频号]\nprivateResolve: true\n"
  const config = site => loadPublicShareConfig(site, root)
  let calls = 0
  const module = createWeixinChannelsPreview({
    loadConfig: config,
    async fetch(url) { calls++; return url === share ? Response.redirect(page) : publicResult(data) },
    render: async () => png,
  })
  const Result = { ok: () => true, error: () => false }
  const session = new AbortController()
  const context = { ...group, message_type: "private", privateCredentialSignal: session.signal }
  try {
    await mkdir(previous, { recursive: true })
    await mkdir(join(dir, "config"), { recursive: true })
    await writeFile(join(previous, "tools.yaml"), legacy)
    await writeFile(global, source)
    const { configInfo: form } = supportGuoba(dir)
    expect((await form.getConfigData()).wxchannels).toEqual({ enable: false, private_preview: true })
    expect(form.schemas.filter(field => field.field?.startsWith("wxchannels.")).map(field => field.component)).toEqual(["Switch", "Switch"])
    expect(await module.fallback(share, context)).toBeUndefined()
    expect(await form.setConfigData({ "wxchannels.enable": true, "wxchannels.private_preview": false },
      { Result, changedFields: ["wxchannels.enable"] })).toBe(true)
    expect(await readFile(global, "utf8")).toBe(source + "wxchannels:\n  enable: true\n")
    expect((await form.getConfigData()).wxchannels).toEqual({ enable: true, private_preview: true })
    expect(await module.fallback(share, context)).toBeUndefined()
    expect(calls).toBe(0)
    await writeFile(global, "# 隔离无权限覆盖\nwxchannels: {enable: true}\n")
    expect(await module.fallback(share, context)).toEqual([{ type: "image", file: png }, "在微信中观看\n" + share])
    expect(calls).toBe(2)
    expect(await readFile(join(previous, "tools.yaml"), "utf8")).toBe(legacy)
    session.abort()
    expect(await module.fallback(share, context)).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("群派发按视频号功能名拦在上游之前，独立用户与群业务黑名单生效", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-channels-routing-"))
  const root = pathToFileURL(dir + "/")
  let calls = 0
  const module = createWeixinChannelsPreview({
    loadConfig: site => loadPublicShareConfig(site, root),
    async fetch(url) { calls++; return url === share ? Response.redirect(page) : publicResult(data) },
    render: async () => png,
  })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "@lotus-yunzai/media", commands: {}, fallback: module.fallback, fallbackFeatures: module.features })
  try {
    const config = join(dir, "config")
    await mkdir(config, { recursive: true })
    await writeFile(join(config, "group.yaml"), '123:\n  disable: ["[media] 视频号分享"]\n')
    await writeFile(join(config, "global.yaml"), 'permissions:\n  users: {deny: [42]}\n  groups: {deny: [321]}\n')
    const routing = await readGroupDispatch(root)
    const dispatch = values => {
      const event = { ...group, msg: share, post_type: "message", ...values }
      return registry.dispatchFallback(event, names => routing.allows(event, names), () => false)
    }
    expect(await dispatch({ group_id: 123, user_id: 43 })).toBeUndefined()
    expect(await dispatch({ group_id: 321, user_id: 43 })).toBeUndefined()
    expect(await dispatch({ group_id: 456, user_id: 42 })).toBeUndefined()
    expect(calls).toBe(0)
    expect(await dispatch({ group_id: 456, user_id: 43 })).toEqual([{ type: "image", file: png }, "在微信中观看\n" + share])
    expect(calls).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
