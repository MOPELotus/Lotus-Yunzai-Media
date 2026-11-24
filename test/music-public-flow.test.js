import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMusicCommands } from "../services/music/command.ts"
import { MusicService } from "../services/music/service.ts"

const song = { platform: "qq", id:"109", ref:"qq:109", name:"当前平台曲目" }
const additional = { ...song, id:"110", ref:"qq:110", name:"下一页曲目" }
const wrong = { platform:"netease", id:"9", ref:"netease:9", name:"不属于本搜索的曲目" }

test("公共点歌只保留本平台结果，音源原曲明确错号时停止", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-music-public-"))
  let origin = song.ref
  const api = new MusicService({ accountsFile:join(directory,"accounts.yaml"),
    tuneweave:{
      async request(route) {
        if (route.startsWith("/v1/search?")) return { accountSelected:false, data:[null,
          { type:"album", data:song }, { type:"track", data:null }, { type:"track", data:wrong },
          { type:"track", data:{ ...song, ref:"netease:109" } }, { type:"track", data:song },
        ] }
        return { url:"https://audio.example.test/full.wav", origin_track:origin,
          resolved_platform:"netease", resolved_track:wrong.ref, trial:false }
      },
    },
  })
  try {
    expect(await api.search("qq", "找歌")).toMatchObject({ tracks:[song] })
    expect(await api.resolve(song)).toMatchObject({ origin_track:song.ref, resolved_track:wrong.ref })
    origin = wrong.ref
    await expect(api.resolve(song)).rejects.toThrow("属于其他歌曲")
  } finally { await rm(directory, { recursive:true, force:true }) }
})

test("普通点歌翻页失败或空页保留上一页的号位", async () => {
  let mode
  const chosen = []
  const messages = []
  const api = { config:{search_limit:10},
    async search(_, __, page) {
      if (page === 1) return { tracks:[song] }
      if (mode === "request") throw new Error("合成翻页请求失败")
      return { tracks:mode === "empty" ? [] : [additional] }
    },
    async prepare(track) { chosen.push(track.ref); throw new Error("合成停止播放") },
  }
  const music = createMusicCommands({
    openMusic:async()=>({api,defaultPlatform:"qq",timeoutMs:120000}),
    renderMusicMenu:async()=>undefined,
  })
  const context = { message_type:"private", user_id:1, self_id:2,
    async reply(value) {
      if (mode === "reply" && typeof value === "string" && value.includes(additional.name)) throw new Error("合成菜单发送失败")
      messages.push(value)
      return true
    },
  }
  try {
    for (mode of ["request","reply","empty"]) {
      expect(await music.fallback("#QQ点歌 合成",context)).toEqual([])
      expect(messages.at(-1)).toContain("1. " + song.name)
      const page = await music.fallback("#下一页",context)
      if (mode === "empty") {
        expect(page).toEqual([])
        expect(messages.at(-1)).toContain("仍可选择本页")
      } else expect(page).toContain("合成")
      expect(await music.fallback("#听1",context)).toContain("合成停止播放")
    }
    expect(chosen).toEqual([song.ref,song.ref,song.ref])
  } finally { await music.dispose() }
})

test.each(["取消搜索", "取消翻页", "替换翻页", "断开翻页"])("%s会停止本次搜歌，不发迟到失败或旧列表", async scenario => {
  const lease = new AbortController()
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const replies = []
  const api = {
    config: { search_limit: 10 },
    async search(_platform, keyword, page, { signal }) {
      if (keyword === "新曲") return { tracks: [additional] }
      if (page === 2 || scenario === "取消搜索") {
        started.resolve(signal)
        await release.promise
        throw new Error("不应发送的迟到错误")
      }
      return { tracks: [song] }
    },
  }
  const music = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "qq", timeoutMs: 120_000 }),
    renderMusicMenu: async () => undefined })
  const context = { message_type: "group", group_id: 1, user_id: 2, self_id: 3, groupActivitySignal: lease.signal,
    async reply(value) { replies.push(value); return true } }
  let pending
  try {
    if (scenario === "取消搜索") pending = music.fallback("#qq搜歌旧曲", context)
    else {
      expect(await music.fallback("#qq搜歌旧曲", context)).toEqual([])
      pending = music.fallback("#音乐下一页", context)
    }
    const signal = await started.promise
    expect(signal.aborted).toBe(false)
    if (scenario === "替换翻页") expect(await music.fallback("#QQ音乐点歌 新曲", context)).toEqual([])
    else if (scenario === "断开翻页") lease.abort()
    else expect(await music.fallback("#音乐取消", context)).toBe("已取消本次音乐操作。")
    expect(signal.aborted).toBe(true)
    const count = replies.length
    release.resolve()
    expect(await pending).toEqual([])
    expect(replies).toHaveLength(count)
    if (scenario === "替换翻页") expect(replies.at(-1)).toContain(additional.name)
    if (scenario.startsWith("取消")) expect(await music.fallback("#听1", context)).toBeUndefined()
  } finally { release.resolve(); await pending; await music.dispose() }
})

test.each(["取消指令","会话断开","替换搜索"])("普通点歌遇到 %s 停止借出媒体并清理任务", async scenario => {
  const started = Promise.withResolvers()
  const ready = Promise.withResolvers()
  const lease = new AbortController()
  const delivered = []
  const cleaned = []
  const api = {
    config:{search_limit:10}, async search(){return {tracks:[song]}},
    async prepare(track,{signal}) {
      started.resolve(signal)
      await ready.promise
      return {track,voiceFile:"/synthetic/voice.wav",stream:{},duration:10}
    },
    async cleanup(result){cleaned.push(result.voiceFile)},
  }
  const music = createMusicCommands({
    openMusic:async()=>({api,defaultPlatform:"qq",timeoutMs:120000}),
    renderMusicMenu:async()=>undefined,
  })
  const context = { message_type:"group", group_id:1, user_id:2, self_id:3, groupActivitySignal:lease.signal,
    async reply(){return true}, async deliverMedia(file){delivered.push(file);return "confirmed"} }
  let pending
  try {
    expect(await music.fallback("#QQ点歌 合成",context)).toEqual([])
    pending=music.fallback("1",context)
    const signal=await started.promise
    expect(signal.aborted).toBe(false)
    if (scenario === "取消指令") expect(await music.fallback("#取消",context)).toBe("已取消本次音乐操作。")
    else if (scenario === "会话断开") lease.abort()
    else expect(await music.fallback("#QQ点歌 新曲",context)).toEqual([])
    expect(signal.aborted).toBe(true)
    ready.resolve()
    expect(await pending).toEqual([])
    expect(delivered).toEqual([])
    expect(cleaned).toEqual(["/synthetic/voice.wav"])
  } finally { ready.resolve(); await pending; await music.dispose() }
})
