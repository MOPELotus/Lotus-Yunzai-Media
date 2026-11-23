import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { CommandRegistry } from "../../../lib/commands.ts"
import type { MessageEvent } from "../../../lib/messages.ts"
import { lockFile } from "../../../lib/file-lock.ts"
import { createModule } from "../index.ts"
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
      options: async () => ({ enable: enabled, private: false }),
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
    expect(await dispatch(event, "[media] B 站番剧预览")).toBeUndefined()
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
    expect(await loadBiliPgcSettings(root, store.settings)).toEqual({ enable: true, private: false })
    await mkdir(source, { recursive: true })
    await writeFile(join(source, "tools.yaml"), "globalBlackList: [哔哩哔哩]\nprivateResolve: true\n")
    expect(await loadBiliPgcSettings(root, store.settings)).toEqual({ enable: false, private: true })
    await writeFile(join(source, "tools.yaml"), "globalBlackList: []\nprivateResolve: true\n")
    await store.editSettings("bilibili", () => ({ parseVideoLink: 0 }))
    expect(await loadBiliPgcSettings(root, store.settings)).toEqual({ enable: false, private: true })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
