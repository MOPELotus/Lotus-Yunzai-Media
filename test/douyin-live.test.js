import { expect, test } from "bun:test"
import { CommandRegistry } from "../../../lib/commands.ts"
import { createDouyinCommands } from "../services/douyin/command.ts"
import { readDouyinLive } from "../services/douyin/live.ts"
import { resolveDouyinShare } from "../services/douyin/links.ts"
import { DouyinService } from "../services/douyin/service.ts"

const short = "https://v.douyin.com/fixture/"
const id = "7037755191311043335"
const url = `https://webcast.amemv.com/webcast/reflow/${id}`
const share = { kind: "live", id, url }
const room = { idStr: id, title: "公开测试房间", owner: { nickname: "测试主播" }, userCount: 0,
  status: 4, startTime: 1638605124, finishTime: 1638605840 }

function markup(changes = {}, props = {}) {
  const row = JSON.stringify(["$", "$L4", null, { data: { room: { ...room, ...changes } }, id, hasError: false, ...props }])
  return `<html><script>self.__rsc_f.push([1,${JSON.stringify("3:" + row + "\n")}])</script></html>`
}

test("抖音官方直播分享仅走同房间的公开页面，跳转参数不进入房间或返还链接", async () => {
  const requests = []
  const preview = new DouyinService({ async fetch(input, options) {
    requests.push([input, options.redirect])
    expect(new Headers(options.headers).has("cookie")).toBe(false)
    expect(new Headers(options.headers).has("authorization")).toBe(false)
    if (input === short) return new Response(null, { status: 302, headers: { location: url + "?token=ignored&item_id=42#ignored" } })
    expect(input).toBe(url)
    return new Response(markup())
  } })
  const cards = [], replies = []
  let enabled = true
  const commands = createDouyinCommands({}, { makeService: () => preview,
    loadConfig: async () => ({ douyin: { enable: enabled }, permissions: { scopes: { "douyin.download": { policy: "deny" } } } }),
    renderLiveCard: async card => { cards.push(card); return Buffer.from("image") },
  })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "@lotus-yunzai/media", commands: {}, fallback: commands.fallback, fallbackFeatures: commands.features })
  const event = { message_type: "group", group_id: 99, user_id: 42, msg: "打开抖音观看 " + short,
    reply: async message => { replies.push(message); return true } }
  try {
    expect(await registry.dispatchFallback(event, () => false, () => false)).toBeUndefined()
    enabled = false
    expect(await registry.dispatchFallback(event, () => true, () => false)).toBeUndefined()
    expect(requests).toEqual([])
    enabled = true
    expect(await registry.dispatchFallback(event, () => true, () => false)).toEqual([])
    expect(requests).toEqual([[short, "manual"], [url, "error"]])
    expect(cards[0]).toMatchObject({ title: "直播已结束", subtitle: "抖音",
      items: [{ label: "房间标题", value: "公开测试房间" }, { label: "主播", value: "测试主播" }, { label: "页面显示观看人数", value: "0" }] })
    expect(replies).toEqual([{ type: "image", file: Buffer.from("image") }, url])
    expect(await registry.dispatchFallback({ ...event, msg: "#抖音下载 " + url }, () => true, () => false)).toEqual([])
    expect(replies.at(-1)).toBe("抖音直播仅提供房间预览。\n" + url)
    expect(requests).toHaveLength(3)
  } finally { await commands.dispose() }
})

test("抖音直播状态与同房间有效资料核验，含误导分享正文和不可信跳转", async () => {
  const body = html => ({ fetch: async () => new Response(html) })
  await expect(readDouyinLive(share, body(markup({ idStr: "9037755191311043335" })))).rejects.toThrow("未能核实")
  await expect(readDouyinLive(share, body(markup({}, { id: "9037755191311043335" })))).rejects.toThrow("未能核实")
  await expect(readDouyinLive(share, body(markup({}, { hasError: true })))).rejects.toThrow("未能核实")
  await expect(readDouyinLive(share, body(markup({ status: 2, finishTime: 0, userCount: 32 })))).resolves.toMatchObject({ status: "直播中", viewers: 32 })
  await expect(readDouyinLive(share, body(markup({ status: 4, finishTime: 0 })))).resolves.toMatchObject({ status: "直播状态待确认" })
  const requests = []
  for (const redirect of ["https://example.test/webcast/reflow/" + id, "https://webcast.amemv.com/webcast/private/" + id]) {
    await expect(resolveDouyinShare(short, { fetch: async input => {
      requests.push(input)
      return new Response(null, { status: 302, headers: { location: redirect } })
    } })).rejects.toThrow("域名")
  }
  await expect(resolveDouyinShare("分享口令 ##synthetic## 打开抖音", { fetch: async input => { requests.push(input) } })).rejects.toThrow("链接")
  expect(requests).toEqual([short, short])
})

test("抖音公开房间状态放在表头，保留房间原题和文字回退", async () => {
  const staleTitle = "🇨🇳戈壁...正在直播"
  const service = new DouyinService({ fetch: async () => new Response(
    "<title>抖音</title>" + markup({ title: staleTitle })) })
  const cards = [], replies = []
  const commands = createDouyinCommands({}, { makeService: () => service,
    loadConfig: async () => ({ douyin: { enable: true }, permissions: {} }),
    renderLiveCard: async card => { cards.push(card); return undefined },
  })
  try {
    expect(await commands.fallback(url, { message_type: "private", user_id: 42,
      reply: async value => { replies.push(value); return true },
    })).toEqual([])
    expect(cards[0]).toMatchObject({ title: "直播已结束", items: [{ label: "房间标题", value: "戈壁...正在直播" },
      { label: "主播", value: "测试主播" }, { label: "页面显示观看人数", value: "0" }],
    })
    expect(replies).toEqual([`抖音 · 直播已结束\n房间标题 ${staleTitle}\n主播 测试主播\n页面显示观看人数 0`, url])
  } finally { await commands.dispose() }
})
