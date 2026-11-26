import { expect, test, spyOn } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BilibiliService, quotedBiliCardLink } from "../services/bilibili/service.ts"
import { createBilibiliVideoCommands } from "../services/bilibili/video-command.ts"

const bvid = "BV17x411w7KC"
const ref = "bilibili:bvid:" + bvid
const link = "https://www.bilibili.com/video/" + bvid
const video = { ref, title: "合成稿件", duration_ms: 300_000, extensions: { bvid, aid: 170001 } }
const parts = [1, 2, 3].map(page => ({ id: "cid:" + (100 + page), page, title: "片段 " + page,
  video_ref: ref, duration_ms: 5000 * page }))
const ok = (data, alias) => Response.json({ ok: true, data, meta: { platform: "bilibili", ...(alias && { account: alias }) } })
const absent = () => Response.json({ ok: false, error: { code: "authentication_required" } }, { status: 401 })

test("取消 B 站多 P 打包会终止压缩进程并清理任务", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "lotus-bili-zip-cancel-"))
  const tasksDir = join(workDir, "tasks")
  const abort = new AbortController()
  let spawned = 0
  let stopped = false
  try {
    const service = new BilibiliService({ accountFile: join(workDir, "account.yaml"), tasksDir,
      spawn(_program, _args, options) {
        spawned++
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], options)
        child.once("close", () => { stopped = true })
        queueMicrotask(() => abort.abort())
        return child
      },
    })
    service.buildDownloadPlan = async () => ({ ok: true, info: { bvid, title: "合成稿件" }, policy: "zip", pages: parts })
    service.downloadWithTuneWeave = async (_plan, _config, task) => {
      const files = [join(task, "P1.mp4"), join(task, "P2.mp4")]
      await Promise.all(files.map(file => writeFile(file, "fixture")))
      return files
    }
    await expect(service.download(link, { timeout_ms: 1_000 }, { signal: abort.signal })).rejects.toThrow("已取消")
    expect(spawned).toBe(1)
    expect(stopped).toBe(true)
    expect(await readdir(tasksDir)).toEqual([])
  } finally { await rm(workDir, { recursive: true, force: true }) }
})

test("重复请求 B 站登录先核对原别名，能续期时不需要重扫", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "lotus-bili-login-"))
  const accountFile = join(workDir, "account.yaml")
  const alias = "fixture-login"
  const initial = `tuneweave_account: ${alias}\nsaved_at: first\nuser_id: "123456"\n`
  const paths = []
  const profile = { platform: "bilibili", account: alias, authenticated: true, user_id: "123456" }
  let session = profile
  let renewal = profile
  const check = () => new BilibiliService({ accountFile, fetch: async (input, init) => {
    const url = new URL(input)
    paths.push(url.pathname)
    if (url.pathname.endsWith("/refresh")) {
      expect(init.redirect).toBe("error")
      expect(JSON.parse(init.body)).toEqual({ platform: "bilibili", account: alias, credential_mode: "server" })
      return renewal ? ok(renewal, alias) : absent()
    }
    expect(url.searchParams.get("account")).toBe(alias)
    return ok(session, alias)
  } }).hasReusableLogin()
  try {
    expect(await check()).toBe(false)
    expect(paths).toEqual([])
    await writeFile(accountFile, initial)
    expect(await check()).toBe(true)
    expect(paths.splice(0)).toEqual(["/v1/auth/session"])
    session = { ...profile, authenticated: false }
    expect(await check()).toBe(true)
    expect(paths.splice(0)).toEqual(["/v1/auth/session", "/v1/auth/session/refresh"])
    renewal = { ...profile, user_id: "123457" }
    await expect(check()).rejects.toThrow("原 B 站账号续期")
    renewal = { ...profile, authenticated: undefined }
    await expect(check()).rejects.toThrow("原 B 站账号续期")
    renewal = undefined
    expect(await check()).toBe(false)
    session = { ...profile, user_id: "123457" }
    await expect(check()).rejects.toThrow("原 B 站账号")
    expect(await Bun.file(accountFile).text()).toBe(initial)
  } finally { await rm(workDir, { recursive: true, force: true }) }
})

test("引用 B 站分享卡保留单一合法分 P，缺省才使用无页码链接", () => {
  const card = jumpUrl => ({ meta: { news: { jumpUrl } } })
  expect(quotedBiliCardLink(card(link + "?p=2&spm_id_from=demo#section"))).toBe(link + "?p=2")
  expect(quotedBiliCardLink(card(link + "?spm_id_from=demo"))).toBe(link)
  for (const query of ["p=1&p=2", "p=0", "p=-1", "p=abc", "p="]) {
    expect(quotedBiliCardLink(card(link + "?" + query))).toBeUndefined()
  }
})

test("可见 B 站链接与异站分享卡同条发送时，异站卡不遮蔽链接", async () => {
  const life = new AbortController()
  const targets = []
  const module = createBilibiliVideoCommands({
    signal: life.signal,
    settings: async () => ({ parseVideoLink: true }),
    async fetch(input) {
      const url = new URL(input)
      targets.push(decodeURIComponent(url.pathname))
      life.abort()
      return ok({ video })
    },
  })
  const foreign = "https://www.douyin.com/video/11111111"
  const probe = (message, card) => module.fallback(message, { message_type: "group", self_id: 99, group_id: 77, user_id: 42,
    normalizedMessage: message, raw_message: message + " [CQ:json,data=" + JSON.stringify(card) + "]",
    message: [{ type: "text", text: message }, { type: "json", data: card }], reply: async () => true })
  try {
    await expect(probe("", { meta: { news: { jumpUrl: foreign, description: "卡片里的引用 " + link } } })).resolves.toBeUndefined()
    expect(targets).toEqual([])
    await probe("直接发送 " + link, { meta: { news: { jumpUrl: foreign } } })
    expect(targets).toEqual(["/v1/videos/" + ref])
  } finally {
    await module.dispose()
  }
})

test("旧分享提取以实际作品链接为准，链接参数和外站地址不会抢占入口", async () => {
  const service = new BilibiliService({ fetch: async () => { throw new Error("提取不应联网") } })
  const room = "https://live.bilibili.com/42"
  const videoWithLiveParameter = link + "?from=" + room + "&p=2"
  expect(await service.resolveTarget(videoWithLiveParameter)).toEqual({ type: "video", bvid, page: 2 })
  expect(await service.resolveTarget(room + "/?from=share")).toEqual({ type: "live", roomId: "42" })
  expect(await service.resolveTarget("https://m.bilibili.com/video/av000170001?p=2")).toEqual({ type: "video", aid: "170001", page: 2 })
  await expect(service.resolveTarget(room + "/description")).rejects.toThrow("不支持的 B 站链接")
  expect(await service.resolveTarget("https://live.bilibili.com/00042")).toEqual({ type: "live", roomId: "42" })
  expect(service.extractTarget(room + "backup")).toBe("")
  expect(service.extractTarget("参考 " + room + ".")).toBe(room)
  const xml = '<msg url="' + link + '?from=share&amp;p=2"></msg>'
  expect(await service.resolveTarget(service.extractTarget(xml))).toEqual({ type: "video", bvid, page: 2 })
  const news = { homepage: "https://www.bilibili.com/", profile: "https://m.bilibili.com/space/42",
    preview: "https://live.bilibili.com/311", jumpUrl: link }
  expect(service.extractTarget(JSON.stringify({ meta: { news } }))).toBe(link)
  expect(service.extractTarget(JSON.stringify({ homepage: news.homepage }))).toBeNull()
  expect(service.extractTarget(JSON.stringify({ player: room }))).toBe(room)
  expect(service.extractTarget(JSON.stringify({ light_app: { target: "https://www.bilibili.com/bangumi/play/ep42" } })))
    .toBe("https://www.bilibili.com/bangumi/play/ep42")
  for (const foreign of ["https://example.test/video/" + bvid, "https://[::1]/?video=" + bvid,
    "https://bilibili.com.example.test/video/" + bvid, "https://example.test/?live=" + room]) {
    expect(service.extractTarget(foreign)).toBe("")
    expect(service.extractTarget(foreign + " " + bvid)).toBe(bvid)
  }
})

test("普通解析关闭时直链直播仍只输出房间和独立播放器，停止后不回消息", async () => {
  const signals = []
  const replies = []
  const room = "https://live.bilibili.com/42"
  const lease = new AbortController()
  let abort = false
  const module = createBilibiliVideoCommands({ settings: async () => ({ parseVideoLink: false }),
    async fetch(input, options) {
      const url = new URL(input)
      expect(url.hostname).toBe("api.live.bilibili.com")
      expect(url.searchParams.get("room_id")).toBe("42")
      expect(options.credentials).toBe("omit")
      expect(options.redirect).toBe("error")
      signals.push(options.signal)
      if (abort) lease.abort()
      return Response.json({ code: 0, data: { title: "合成直播间", uname: "合成主播", live_status: 1, online: 1 } })
    },
  })
  const context = { message_type: "private", self_id: 99, user_id: 42,
    privateCredentialSignal: lease.signal,
    reply: async message => { replies.push(message); return false } }
  const invoke = message => module.fallback(message, { ...context, normalizedMessage: message })
  try {
    expect(await invoke("#B站下载")).toContain("请输入要下载的")
    expect(await invoke("#b站下视频")).toContain("请输入要下载的")
    expect(await invoke(link + "?redirect=" + room)).toBeUndefined()
    expect(await invoke("https://b23.tv/example")).toBeUndefined()
    expect(signals).toEqual([])
    expect(await invoke(room)).toEqual([])
    expect(replies[0]).toMatchObject({ type: "image" })
    expect(replies.slice(1)).toEqual(["B站解析完成。",
      "独立播放器：https://www.bilibili.com/blackboard/live/live-activity-player.html?cid=42"])
    expect(signals[0].aborted).toBe(false)
    abort = true
    const previous = replies.length
    expect(await invoke(room)).toEqual([])
    expect(signals[1].aborted).toBe(true)
    expect(replies).toHaveLength(previous)
  } finally {
    await module.dispose()
  }
})

test("B 站桌面、手机与短链保留 TuneWeave 的明确分 P，错集不会下载", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "lotus-bili-part-"))
  const calls = []
  const tuneSignals = []
  let partRows = parts
  const service = new BilibiliService({ accountFile: join(workDir, "account.yaml"),
    async fetch(input, init) {
      const url = new URL(input)
      if (url.hostname === "b23.tv") return Response.redirect(link + "?p=2")
      expect(url.hostname).toBe("127.0.0.1")
      calls.push(url)
      tuneSignals.push(init?.signal)
      if (url.pathname.endsWith("/parts")) return ok(partRows)
      if (url.pathname.endsWith("/playback")) return ok({ video_ref: ref, part_ref: "bilibili:cid:101" })
      return ok({ video })
    },
  })
  const signal = new AbortController().signal
  try {
    expect(await service.resolveTarget("https://m.bilibili.com/video/" + bvid + "?p=3")).toEqual({ type: "video", bvid, page: 3 })
    expect(await service.resolveTarget("https://b23.tv/example", signal)).toEqual({ type: "video", bvid, page: 2 })
    expect(service.extractTarget("分享（" + link + "?p=2）")).toBe(link + "?p=2")
    const config = { duration_limit_seconds: 15, multi_page_policy: "zip" }
    const plan = await service.buildDownloadPlan(link + "?p=2", config, signal)
    expect(plan).toMatchObject({ ok: true, info: { url: link + "?p=2", cid: "102", duration: 10, title: "合成稿件 · P2 片段 2" }, })
    expect(plan.pages.map(({ page, cid }) => [page, cid])).toEqual([[2, "102"]])
    await expect(service.downloadWithTuneWeave(plan, { ...config, tools_path: "data/tools/bin" }, workDir, { signal })).rejects.toThrow("所选分 P")
    expect(calls.at(-1).searchParams.get("part")).toBe("cid:102")
    expect(tuneSignals.every(Boolean)).toBe(true)
    await expect(service.getInfo(link + "?p=99")).rejects.toThrow("指定分 P")
    await expect(service.getInfo(link + "?p=2&p=1")).rejects.toThrow("编号无效")
    partRows = [{ ...parts[1], video_ref: "bilibili:bvid:BV1Jt411P77c" }]
    await expect(service.getInfo(link + "?p=2")).rejects.toThrow("不匹配")
  } finally { await rm(workDir, { recursive: true, force: true }) }
})

test("高清晰度不可选时，B 站最低档仍优先同档 AVC", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-bili-minimum-quality-"))
  const selected = []
  const service = new BilibiliService({ accountFile: join(root, "account.yaml"), async fetch(input) {
    const url = new URL(input)
    if (url.hostname === "fixture.example") {
      selected.push(url.pathname)
      throw new Error("轨道选择已记录")
    }
    expect(url.pathname.endsWith("/playback")).toBe(true)
    return ok({ video_ref: ref, part_ref: "bilibili:cid:101", video_tracks: [
      { id: 16, codec_id: 12, url: "https://fixture.example/hevc" },
      { id: 64, codec_id: 7, url: "https://fixture.example/higher" },
      { id: 16, codec_id: 7, url: "https://fixture.example/avc" },
    ] })
  } })
  try {
    const plan = { info: { ref, bvid }, pages: [{ cid: "101", page: 1 }] }
    await expect(service.downloadWithTuneWeave(plan, { resolution: 1, tools_path: "data/tools/bin" }, root)).rejects.toThrow("轨道选择已记录")
    expect(selected).toEqual(["/avc"])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("B 站视频认证失效后只续原账号一次，确认原别名与 UID 后才重试", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "lotus-bili-renew-"))
  const accountFile = join(workDir, "account.yaml")
  const alias = "fixture-video-account"
  const original = `tuneweave_account: ${alias}\nsaved_at: first\nuser_id: "123456"\n`
  await writeFile(accountFile, original)
  const requests = []
  let readCounter = 0
  let refreshMode = "correct"
  let sessionMeta = alias
  const service = () => new BilibiliService({ accountFile, async fetch(input, init) {
    const url = new URL(input)
    expect(init.redirect).toBe("error")
    expect(new Headers(init.headers).get("Cookie")).toBeNull()
    if (url.pathname.endsWith("/auth/session/refresh")) {
      const body = JSON.parse(String(init.body))
      expect(body).toEqual({ platform: "bilibili", account: alias, credential_mode: "server" })
      requests.push(["refresh", body.account])
      if (refreshMode === "swapped") await writeFile(accountFile, original.replace("saved_at: first", "saved_at: second"))
      return ok({ authenticated: true, account: alias, platform: "bilibili", user_id: refreshMode === "uid" ? "123457" : "123456" }, sessionMeta)
    }
    requests.push(["read", url.searchParams.get("account")])
    return readCounter++ ? ok(url.pathname.endsWith("/parts") ? parts : { video }, sessionMeta) : absent()
  } })
  try {
    expect((await service().getInfo(link + "?p=2")).url).toBe(link + "?p=2")
    expect(requests).toEqual([["read", alias], ["refresh", alias], ["read", alias], ["read", alias]])
    for (const mode of ["uid", "swapped"]) {
      await writeFile(accountFile, original)
      requests.length = 0
      readCounter = 0
      refreshMode = mode
      await expect(service().getInfo(link + "?p=2")).rejects.toThrow("原")
      expect(requests).toEqual([["read", alias], ["refresh", alias]])
    }
    const legacy = original.replace(/^user_id:.*\n/m, "") + 'cookie: "DedeUserID=987654"\n'
    await writeFile(accountFile, legacy)
    requests.length = 0
    readCounter = 0
    await expect(service().getInfo(link)).rejects.toThrow("请重新扫码登录")
    expect(requests).toEqual([["read", alias]])
    expect(await Bun.file(accountFile).text()).toBe(legacy)
    readCounter = 1
    requests.length = 0
    expect((await service().getInfo(link)).type).toBe("video")
    expect(requests).toEqual([["read", alias], ["read", alias]])

    await writeFile(accountFile, original)
    readCounter = 1
    requests.length = 0
    sessionMeta = "different"
    await expect(service().getInfo(link)).rejects.toThrow("未确认原 B 站账号")
    expect(requests).toEqual([["read", alias]])
  } finally { await rm(workDir, { recursive: true, force: true }) }
})

test("B站视频发送结果未知时保持静默且不重发，明确失败时仍返回回执", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-bili-delivery-"))
  const file = join(directory, "fixture.mp4")
  await writeFile(file, "fixture")
  let deliveries = 0, downloads = 0, releases = 0
  let outcome = "unknown"
  const messages = []
  const download = spyOn(BilibiliService.prototype, "download").mockImplementation(async () => {
    downloads++
    return { ok: true, files: [file], fileNames: { [file]: "fixture.mp4" } }
  })
  const release = spyOn(BilibiliService.prototype, "releaseTask").mockImplementation(async () => { releases++ })
  const api = createBilibiliVideoCommands({})
  const context = { message_type: "private", self_id: 99, user_id: 42, isMaster: true,
    deliverMedia: async () => { deliveries++; return outcome },
    reply: async message => { messages.push(message); return message?.type !== "video" },
  }
  try {
    for (const state of ["unknown", "confirmed"]) {
      outcome = state
      expect(await api.fallback("#B站下载 " + link, context)).toEqual([])
      expect(messages).toEqual([])
    }
    expect(downloads).toBe(2)
    expect(deliveries).toBe(2)
    expect(releases).toBe(2)
    outcome = "rejected"
    expect(await api.fallback("#B站下载 " + link, context)).toEqual([])
    expect(messages.some(message => message?.type === "video")).toBe(true)
    expect(messages.some(message => message?.type === "image")).toBe(true)
    expect(downloads).toBe(3)
    expect(deliveries).toBe(3)
    expect(releases).toBe(3)
  } finally {
    await api.dispose()
    download.mockRestore()
    release.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})
