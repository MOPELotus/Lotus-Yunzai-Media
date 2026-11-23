import { expect, test } from "bun:test"
import { CommandRegistry } from "../../../lib/commands.ts"
import { createMusicCommands } from "../services/music/command.ts"

test("旧点歌短语沿用同会话搜索和点播，优先级与非音乐播放不受影响", async () => {
  const searches = [], deliveries = []
  const api = {
    config: { search_limit: 10 },
    async search(platform, name, page, options) {
      searches.push({ platform, name, page, options })
      return { tracks: [{ platform, name, id: "123", duration_ms: 2000 }], accountStatus: "unconfigured" }
    },
    async prepare(track) { return { track, duration: 2, stream: {}, voiceFile: "isolated.wav" } },
    async cleanup() {},
  }
  const music = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "netease", timeoutMs: 120000 }) })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "fixture-first", commands: {}, fallback: message => message === "播放 由上层接管" ? "优先模块" : undefined })
  registry.registerModule({ name: "@lotus-yunzai/media", commands: {}, fallback: music.fallback, fallbackFeatures: music.features })
  registry.registerModule({ name: "fixture-video", commands: {}, fallback: message => /^播放/u.test(message) ? "视频模块" : undefined })
  const event = { message_type: "group", group_id: 70, user_id: 80, self_id: 90, message: [], adapter: "onebot",
    reply: async () => true, deliverMedia: async file => { deliveries.push(file.name); return "confirmed" } }
  const run = (msg, fields = {}, allowed = () => true) => registry.dispatchFallback({ ...event, msg, ...fields }, allowed, () => false)
  try {
    expect(await run("点歌功能设置")).toBeUndefined()
    expect(await run("来首歌")).toBeUndefined()
    expect(await run("下一页")).toBeUndefined()
    expect(await run("播放 由上层接管")).toBe("优先模块")
    for (const input of ["播放视频", "播放 视频 BV17xxx", "播放 https://example.test/video/1", "播放 片段.mp4", "播放 /tmp/music.mp3", "播放 文件 music.wav"]) {
      expect(await run(input)).toBe("视频模块")
    }
    expect(await run("点歌：晴天", {}, names => !names.includes("[media] 点歌"))).toBeUndefined()
    expect(await run("点歌：晴天", { isDelegated: true })).toBeUndefined()
    expect(searches).toEqual([])
    expect(await run("点歌：晴天")).toEqual([])
    expect(await run("下一页", { adapter: "milky" })).toBeUndefined()
    expect(await run("下一页")).toEqual([])
    expect(await run("1")).toEqual([])
    for (const input of ["点播 青花瓷", "来一首月亮代表我的心", "放一首 夜空中最亮的星", "QQ点播音乐晴天", "#点播孤勇者", "播放 七里香"]) {
      expect(await run(input)).toEqual([])
    }
    expect(searches.map(({ platform, name, page }) => [platform, name, page])).toEqual([
      ["netease", "晴天", 1], ["netease", "晴天", 2], ["netease", "青花瓷", 1], ["netease", "月亮代表我的心", 1],
      ["netease", "夜空中最亮的星", 1], ["qq", "晴天", 1], ["netease", "孤勇者", 1], ["netease", "七里香", 1],
    ])
    expect(deliveries).toHaveLength(7)
  } finally { await music.dispose() }
}, 30_000)
