import { expect, setSystemTime, test } from "bun:test"
import { CommandRegistry } from "../../../lib/commands.ts"
import { createMusicCommands } from "../services/music/command.ts"

function fixture(search, config = {}, open) {
  const api = { config: { search_limit: 10, ...config }, search }
  const settings = { api, defaultPlatform: "qq", timeoutMs: 120_000 }
  const music = createMusicCommands({ openMusic: () => open ? open(settings) : Promise.resolve(settings) })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "music", commands: {}, fallback: music.fallback, fallbackFeatures: music.features })
  const event = { message_type: "group", group_id: 50, user_id: 60, self_id: 70 }
  const run = (msg, reply, changes) => registry.dispatchFallback({ ...event, ...changes, msg, reply }, () => true, () => false)
  return { music, run }
}

const result = (name, offset) => ({ tracks: [{ id: String(offset + 1), ref: `qq:${offset + 1}`, platform: "qq", name }] })

test("多选换页与新搜索立即清理原列表，延迟送达的旧列表单独撤回", async () => {
  const pageQuery = Promise.withResolvers()
  const nextOpen = Promise.withResolvers()
  let delayOpen = false
  const { music, run } = fixture(async (_platform, name, _page, { offset }) => {
    if (name === "旧" && offset === 20) await pageQuery.promise
    return result(name, offset)
  }, {}, async settings => {
    if (delayOpen) await nextOpen.promise
    return settings
  })
  const recalled = []
  const lateReply = Promise.withResolvers()
  const arrived = Promise.withResolvers()
  function delivery(name, { late, confirmed = true } = {}) {
    return async (message, _quoted, options) => {
      if (typeof message !== "string") return false
      if (!confirmed) return true
      if (late) {
        arrived.resolve()
        await lateReply.promise
      }
      options?.onOwnReply?.(async () => { recalled.push(name); return "confirmed" })
      return true
    }
  }
  try {
    await run("#多选点歌 旧", delivery("旧首页"))
    await run("#点歌 被委派", delivery("委派"), { isDelegated: true })
    await run("#取消", delivery("不同会话"), { self_id: 71 })
    expect(recalled).toEqual([])
    const paging = run("#下一页", delivery("旧第二页", { late: true }))
    await Bun.sleep(0)
    expect(recalled).toEqual(["旧首页"])
    pageQuery.resolve()
    await arrived.promise
    await run("#多选点歌 新", delivery("新首页"))
    lateReply.resolve()
    await paging
    expect(recalled).toEqual(["旧首页", "旧第二页"])

    delayOpen = true
    const next = run("#点歌 普通", delivery("普通搜索"))
    await Bun.sleep(0)
    expect(recalled).toEqual(["旧首页", "旧第二页", "新首页"])
    expect(await run("#取消", delivery("取消提示"))).toBe("已取消本次音乐操作。")
    nextOpen.resolve()
    await next
    expect(await run("1", delivery("选曲"))).toBeUndefined()

    await run("#多选点歌 无回执", delivery("无回执", { confirmed: false }))
    await run("#取消", delivery("取消提示"))
    await run("#点歌 普通", delivery("普通搜索"))
    await run("#取消", delivery("取消提示"))
    expect(recalled).toEqual(["旧首页", "旧第二页", "新首页"])
  } finally {
    pageQuery.resolve()
    nextOpen.resolve()
    lateReply.resolve()
    await music.dispose()
  }
}, 10_000)

test("多选默认超过两分钟仍可使用，三分钟后到期，设置的短期限可主动撤回菜单", async () => {
  const { music, run } = fixture(async (_platform, name, _page, { offset }) => result(name, offset))
  const start = Date.now()
  const recordedAt = Promise.withResolvers()
  let recalled = 0
  const reply = async (_message, _quoted, options) => {
    if (options?.onOwnReply) {
      recordedAt.resolve(Date.now())
      options.onOwnReply(async () => { recalled++; return "confirmed" })
    }
    return true
  }
  try {
    setSystemTime(start)
    await run("#多选点歌 测试", reply)
    const visible = await recordedAt.promise
    setSystemTime(visible + 120_001)
    expect(await run("999", reply)).toBe("请输入 1–1 的序号。")
    expect(recalled).toBe(0)
    setSystemTime(visible + 180_001)
    expect(await run("999", reply)).toBeUndefined()
    expect(recalled).toBe(1)
  } finally {
    setSystemTime()
    await music.dispose()
  }

  const short = fixture(async (_platform, name, _page, { offset }) => result(name, offset), { session_timeout_ms: 60 })
  try {
    await short.run("#多选点歌 测试", reply)
    expect(recalled).toBe(1)
    await Bun.sleep(150)
    expect(recalled).toBe(2)
    expect(await short.run("999", reply)).toBeUndefined()
  } finally {
    await short.music.dispose()
  }
}, 10_000)
