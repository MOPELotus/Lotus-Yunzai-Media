import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { lockFile } from "../../../lib/file-lock.ts"
import { CommandRegistry, type MessageFallbackContext } from "../../../lib/commands.ts"
import type { MessageEvent } from "../../../lib/messages.ts"
import { createModule } from "../index.ts"
import { supportGuoba } from "../guoba-settings.ts"
import type { SourceCard } from "../core/render/source-cards.ts"
import { createOfficialLinkPreview } from "../services/official-links/command.ts"
import { getOfficialLink, parseOfficialLink, type OfficialLinkFetch } from "../services/official-links/source.ts"
import { createOfficialLinkSettings } from "../services/official-links/settings.ts"

const video = "jNQXAC9IVRw"
const short = `https://youtu.be/${video}?t=10`
const music = `https://music.youtube.com/watch?v=${video}`
const post = "https://t.me/durov/43"
const enabled = { youtube: true, youtubeMusic: true, telegram: true, v2ex: true, articles: true, x: true, private: false, trustedTelegramUsers: ["100"], trustedXUsers: [] }
const response = (id = video) => Response.json({
  type: "video", provider_name: "YouTube",
  html: `<iframe src="https://www.youtube.com/embed/${id}?feature=oembed"></iframe>`,
  author_name: "公开作者", title: "公开作品", thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
})
const postResponse = (id = "43") => new Response(
  `<article class="tgme_widget_message" data-post="durov/${id}"><a class="tgme_widget_message_owner_name">公开频道</a>
   <div class="tgme_widget_message_text">正文<br><span class="tg-spoiler">隐藏段</span>续文</div>
   <a class="tgme_widget_message_photo_wrap" href="https://t.me/durov/${id}" style="background-image:url('https://cdn1.telesco.pe/file/sample.jpg')"></a>
   <a class="tgme_widget_message_date" href="https://t.me/durov/${id}"></a></article>`,
  { headers: { "Content-Type": "text/html" } },
)

const context = (message: string, extra: Partial<MessageFallbackContext> = {}) => ({
  message_type: "group", normalizedMessage: message, user_id: 100, self_id: 200, group_id: 300,
  isMaster: false, async reply() {}, ...extra,
}) as MessageFallbackContext

test("公开链接匹配限定域名、形态和身份，保留来源平台及播放时间", () => {
  expect(parseOfficialLink(short)).toEqual({ platform: "youtube", id: video, link: short })
  expect(parseOfficialLink(music)).toMatchObject({ platform: "youtubeMusic", id: video, link: music })
  expect(parseOfficialLink(post)).toMatchObject({ platform: "telegram", username: "durov", id: "43", link: post })
  for (const link of [
    `https://youtube.com.evil.test/watch?v=${video}`, `https://www.youtube.com@evil.test/watch?v=${video}`,
    `https://www.youtube.com/watch?v=${video}&v=anotherOne1`, "https://t.me/c/12345/12",
    `${post}?comment=317`, `${post}/15`, "https://t.me/share/42", "https://t.me/joinchat/42", "https://t.me/durov",
  ]) expect(parseOfficialLink(link)).toBeUndefined()
})

test("显式网页摘要优先于媒体分享，按摘要权限而非平台自动解析派发", async () => {
  const requests: string[] = []
  const passiveRequests: string[] = []
  let articles = true
  const controller = new AbortController()
  const module = await createModule({ lockFile, signal: controller.signal, officialLinks: {
    settings: async () => ({ ...enabled, articles }),
    fetcher: async url => { passiveRequests.push(url.href); return new Response(null, { status: 404 }) },
    render: async () => Buffer.from("摘录"),
  }, biliPgc: {
    fetcher: async url => { passiveRequests.push(url.href); return new Response(null, { status: 404 }) },
  }, webSummary: {
    model: {
      settings: async () => ({ summaryEnabled: false, summaryMode: "general", summaryBaseUrl: "",
        summaryModel: "", summaryApiKeyConfigured: false }),
      summarize: async () => { throw new Error("未开启摘要模型") },
    },
    publicPage: async link => {
      requests.push(link)
      return { link, title: "公开文章", text: "公开文章正文" }
    },
  } })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "@lotus-yunzai/media", ...module })
  const dispatch = (text: string, allowed = true) => {
    const event: MessageEvent = { ...context(text), msg: text, raw_message: text, message: [], post_type: "message",
      isGroup: true, isPrivate: false }
    return registry.dispatchFallback(event, names => allowed || !names.includes("[media] 网页总结"), () => false)
  }
  try {
    const samples = ["https://www.bilibili.com/bangumi/play/ep2395158",
      "https://www.douyin.com/video/7212345678901234567", "https://www.xiaohongshu.com/explore/674000000000000000000000", post]
    for (const link of samples) {
      const input = "＃总结一下" + link
      expect(module.fallbackFeatures?.(context(input))).toEqual(["[media] 网页总结"])
      expect(await dispatch(input, false)).toBeUndefined()
      expect(await dispatch(input)).toEqual([{ type: "image", file: Buffer.from("摘录") }, { type: "text", text: link }])
    }
    articles = false
    await dispatch("#总结一下 " + samples[0])
    expect(await module.fallback?.("#总结一下 " + samples[0] + " 多余参数",
      context("#总结一下 " + samples[0] + " 多余参数"))).toBeUndefined()
    expect(requests).toEqual(samples)
    expect(passiveRequests).toEqual([])
    expect(module.fallbackFeatures?.(context(post))).toEqual(["[media] Telegram 预览"])
  } finally {
    controller.abort()
    await module.dispose()
  }
})

test("Media 注册 YouTube、Music 与公开 Telegram，来源只发同 ID 的卡和原链接", async () => {
  const calls: URL[] = []
  const cards: SourceCard[] = []
  const fetcher: OfficialLinkFetch = async (url, options) => {
    calls.push(url)
    expect(options).toMatchObject({ credentials: "omit", redirect: "error" })
    if (url.hostname === "www.youtube.com") return response()
    if (url.hostname === "t.me") return postResponse()
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } })
  }
  const controller = new AbortController()
  const module = await createModule({ lockFile, signal: controller.signal, officialLinks: {
    settings: async () => enabled, fetcher,
    render: async (template, card) => {
      expect(template).toBe("bilibili-info")
      cards.push(card)
      return Buffer.from("test")
    },
  } })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "@lotus-yunzai/media", ...module })
  const dispatch = (link: string, blocked?: string) => {
    const event: MessageEvent = { ...context(link), msg: link, raw_message: link, message: [], post_type: "message",
      isGroup: true, isPrivate: false }
    return registry.dispatchFallback(event, names => !blocked || !names.includes(blocked), () => false)
  }
  try {
    expect(await dispatch(post, "[media] Telegram 预览")).toBeUndefined()
    expect(calls).toHaveLength(0)
    for (const [link, label] of [[short, "YouTube"], [music, "YouTube Music"], [post, "Telegram"]] as const) {
      expect(module.fallbackFeatures?.(context(link))).toEqual([`[media] ${label} 预览`])
      expect(await dispatch(link)).toEqual([
        { type: "image", file: Buffer.from("test") }, { type: "text", text: link },
      ])
    }
    const cardSegment = { type: "json", data: JSON.stringify({ jumpUrl: music }) } as const
    expect(await module.fallback?.("", context("", { message: [cardSegment] }))).toEqual([
      { type: "image", file: Buffer.from("test") }, { type: "text", text: music },
    ])
    expect(cards[2]).toMatchObject({ title: "Telegram 公开消息", owner: "公开频道", desc: "正文 续文", cover: Buffer.from([1, 2, 3]), showStats: false })
    expect(new URL(calls[0]!.searchParams.get("url")!).search).toBe("")
    expect(calls[1]!.hostname).toBe("img.youtube.com")
    expect(calls[4]!.href).toBe(post + "?embed=1")
    const disabledCases = [
      context(`#播放 ${short}`), context(post,{ isDelegated: true }),
      context(post, { message_type: "private" }), context(post, { groupActivitySignal: AbortSignal.abort() }),
      context(post, { user_id: 101 }),
    ]
    const number = calls.length
    for (const denied of disabledCases) expect(await module.fallback?.(denied.normalizedMessage, denied)).toBeUndefined()
    expect(calls).toHaveLength(number)
    expect(await module.fallback?.(post, context(post, { user_id: 101, isMaster: true }))).toBeInstanceOf(Array)
  } finally {
    controller.abort()
    await module.dispose()
  }
})

test("公开来源拒绝不同记录及非预期回包，预览失败仍交还原链接", async () => {
  const target = parseOfficialLink(short)!
  const signal = new AbortController().signal
  expect(await getOfficialLink(target, async () => response("dQw4w9WgXcQ"), signal)).toBeUndefined()
  expect(await getOfficialLink(parseOfficialLink(post)!, async () => postResponse("44"), signal)).toBeUndefined()
  await expect(getOfficialLink(target, async () => Response.redirect("https://wrong.example/"), signal)).rejects.toThrow()
  await expect(getOfficialLink(target, async () => new Response(" ".repeat(50_000), {
    headers: { "Content-Type": "application/json" },
  }), signal)).rejects.toThrow("大小限制")
  let renders = 0
  const wrong = createOfficialLinkPreview({ settings: async () => enabled, fetcher: async () => response("dQw4w9WgXcQ"),
    render: async () => { renders++; return Buffer.alloc(10) } })
  expect(await wrong.fallback(short, context(short))).toContain(short)
  expect(renders).toBe(0)
  const tooLarge = createOfficialLinkPreview({ settings: async () => enabled, fetcher: async url =>
    url.hostname === "www.youtube.com" ? response() : new Response(null, { status: 403 }),
    render: async () => { renders++; return Buffer.alloc(10) } })
  expect(await tooLarge.fallback(short, context(short, { inlineImageByteLimit: 5 }))).toBe(`公开作品\n公开作者\n${short}`)
  expect(renders).toBe(2)
})

test("V2EX 分享与显式正文摘录共用主题核验、权限和纯文本回退", async () => {
  const original = "https://www.v2ex.com/t/1187622"
  const alias = "https://fast.v2ex.com/t/1187622?p=2#reply5"
  const normalized = original + "?p=2#reply5"
  const topic = { id: 1187622, url: original, title: "公开主题", member: { username: "作者" },
    node: { title: "节点" }, content: "原帖\n正文", content_rendered: '<img src="https://elsewhere.test/path">' }
  const calls: URL[] = []
  const controller = new AbortController()
  let permitted = true
  let response: typeof topic | undefined = topic
  const probe = createOfficialLinkPreview({
    signal: controller.signal, settings: async () => ({ ...enabled, v2ex: permitted }),
    fetcher: async (url, options) => {
      calls.push(url)
      expect(options).toMatchObject({ credentials: "omit", redirect: "error" })
      return Response.json(response ? [response] : [])
    },
    render: async () => { throw new Error("用文字回退核对字段") },
  })
  expect(parseOfficialLink(alias)).toEqual({ platform: "v2ex", id: "1187622", link: normalized })
  for (const invalid of [original + "/12", original.replace("v2ex.com", "v2ex.com.example"), original.replace("/t/", "/api/t/")]) {
    expect(parseOfficialLink(invalid)).toBeUndefined()
  }
  expect(await probe.fallback(alias, context(alias))).toBe(`公开主题\n作者 · 节点\n原帖 正文\n${normalized}`)
  const command = "#总结一下" + alias
  expect(probe.features(context(command))).toEqual(["[media] V2EX 预览"])
  expect(await probe.fallback(command, context(command))).toContain("原帖 正文")
  expect(calls.map(url => url.href)).toEqual(Array(2).fill("https://www.v2ex.com/api/topics/show.json?id=1187622"))
  for (const wrong of [{ ...topic, id: 1187623 }, { ...topic, url: original.replace("1187622", "1187623") }, undefined]) {
    response = wrong
    expect(await probe.fallback(alias, context(alias))).toBe(`V2EX 暂无法读取公开预览。\n${normalized}`)
  }
  const count = calls.length
  expect(await probe.fallback(alias, context(alias, { message_type: "private" }))).toBeUndefined()
  permitted = false
  expect(await probe.fallback(command, context(command))).toBeUndefined()
  expect(calls).toHaveLength(count)
})

test("原生面板配置开关支持独立保存，修改后直接读取生效", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-official-links-settings-"))
  try {
    await mkdir(join(directory, "media"))
    const official = { settings: async () => ({ groups: [], muted: new Map(), forward: true, cover: false,
      games: [], selected: {} }), async save() {} }
    const { configInfo } = supportGuoba(directory, official)
    const settings = createOfficialLinkSettings(directory)
    const context = { Result: { ok: () => 200, error: (_: string, status: number) => status } }
    expect(await settings.settings()).toEqual({ youtube: true, youtubeMusic: true, telegram: true, v2ex: true, articles: true, x: true, private: false, trustedTelegramUsers: [], trustedXUsers: [] })
    expect(configInfo.schemas).toContainEqual(expect.objectContaining({ field: "officialLinks.telegram", label: "Telegram 公开消息预览", component: "Switch" }))
    expect(configInfo.schemas).toContainEqual(expect.objectContaining({ field: "officialLinks.v2ex", label: "V2EX 主题预览", component: "Switch" }))
    expect(await configInfo.setConfigData({ "officialLinks.v2ex": false }, context)).toBe(200)
    expect((await settings.settings()).v2ex).toBe(false)
    expect(await configInfo.setConfigData({ "officialLinks.v2ex": true }, context)).toBe(200)
    expect(await configInfo.setConfigData({ "officialLinks.youtube": "on" }, context)).toBe(422)
    expect(await configInfo.setConfigData({ "officialLinks.youtube": false, "officialLinks.telegram": false },
      { ...context, changedFields: ["officialLinks.youtube"] })).toBe(200)
    expect(await settings.settings()).toEqual({ youtube: false, youtubeMusic: true, telegram: true, v2ex: true, articles: true, x: true, private: false, trustedTelegramUsers: [], trustedXUsers: [] })
    expect(await configInfo.setConfigData({ "officialLinks.telegram": true, "officialLinks.private": true,
      "officialLinks.trustedTelegramUsers": ["12345"] }, context)).toBe(200)
    expect(await configInfo.getConfigData()).toMatchObject({ officialLinks: { youtube: false, youtubeMusic: true, telegram: true, v2ex: true, articles: true, x: true, private: true, trustedTelegramUsers: ["12345"] } })
    expect(await readFile(join(directory, "media", "official-links.yaml"), "utf8")).toContain("private: true")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("继承旧 YouTube 黑名单、私聊和可信 Telegram QQ，显式新设置可安全清空", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-official-links-legacy-"))
  try {
    const root = pathToFileURL(directory + "/")
    const data = join(directory, "data")
    const old = join(directory, "backup/plugins/rconsole-plugin/config")
    const keys: string[] = []
    let redis: string | null = JSON.stringify(["12345", 12346, "all", { uid: "12347" }, "12345", 8.5])
    const settings = createOfficialLinkSettings(data, root, () => ({ async get(key) { keys.push(key); return redis } }))
    expect(await settings.settings()).toEqual({ youtube: true, youtubeMusic: true, telegram: true, v2ex: true, articles: true, x: true, private: false, trustedTelegramUsers: [], trustedXUsers: [] })
    expect(keys).toHaveLength(0)
    await mkdir(old, { recursive: true })
    await writeFile(join(old, "tools.yaml"), "globalBlackList: [YouTube, 小飞机, AI总结]\nprivateResolve: true\n")
    expect(await settings.settings(false)).toEqual({ youtube: false, youtubeMusic: false, telegram: false, v2ex: false, articles: false, x: true, private: true, trustedTelegramUsers: [], trustedXUsers: [] })
    expect(keys).toHaveLength(0)
    expect(await settings.settings()).toEqual({
      youtube: false, youtubeMusic: false, telegram: false, v2ex: false, articles: false, x: true, private: true, trustedTelegramUsers: ["12345", "12346"], trustedXUsers: ["12345", "12346"],
    })
    expect(keys).toEqual(["Yz:rconsole:tools:whitelist"])
    redis = "invalid"
    expect((await settings.settings()).trustedTelegramUsers).toEqual([])
    redis = JSON.stringify(["12345"])
    await settings.save({ youtube: true, private: false, trustedTelegramUsers: [], trustedXUsers: [] })
    expect(await settings.settings()).toEqual({ youtube: true, youtubeMusic: false, telegram: false, v2ex: false, articles: false, x: true, private: false, trustedTelegramUsers: [], trustedXUsers: [] })
    expect(keys).toHaveLength(2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
