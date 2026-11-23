import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { CommandRegistry } from "../../../lib/commands.ts"
import { lockFile } from "../../../lib/file-lock.ts"
import type { MessageEvent } from "../../../lib/messages.ts"
import { createModule } from "../index.ts"
import { supportGuoba } from "../guoba-settings.ts"
import { getOfficialLink, parseOfficialLink } from "../services/official-links/source.ts"
import { createOfficialLinkSettings } from "../services/official-links/settings.ts"

const post = "https://x.com/Example/status/123"
const legacyLink = "http://r.com/oldHandle/status/123/photo/2?s=20"
const response = (changes: Record<string, unknown> = {}) => Response.json({
  type: "rich", provider_name: "X", url: post, author_url: "https://x.com/Example", author_name: "公开作者",
  html: `<blockquote class="twitter-tweet"><p>同一条 &amp; 正文<br><span>续句</span><script>忽略</script></p>— 公开作者 <a href="${post}?src=official">May 5</a></blockquote>`,
  ...changes,
})
const event = (msg: string, changes: Partial<MessageEvent> = {}): MessageEvent => ({
  msg, raw_message: msg, message: [], message_type: "group", post_type: "message", isGroup: true, isPrivate: false,
  user_id: 9001, group_id: 2000, self_id: 8000, isMaster: false, async reply() { return true }, ...changes,
})
const signal = new AbortController().signal

test("X 兼容旧域和原帖编号，只展示经官方回包核实的同一原帖", async () => {
  const target = parseOfficialLink(legacyLink)!
  expect(target).toEqual({ platform: "x", id: "123", link: "https://x.com/oldHandle/status/123" })
  expect(parseOfficialLink("https://twitter.com/Example/status/123")).toMatchObject({ link: post })
  for (const value of [post + "/analytics", "https://x.com.example/Example/status/123",
    "https://x.com@evil.example/Example/status/123", "https://x.com:444/Example/status/123"]) {
    expect(parseOfficialLink(value)).toBeUndefined()
  }
  const preview = await getOfficialLink(target, async (url, init) => {
    expect(url.origin + url.pathname).toBe("https://publish.x.com/oembed")
    expect(Object.fromEntries(url.searchParams)).toEqual({ url: target.link, hide_thread: "true", omit_script: "true", dnt: "true" })
    expect(init).toMatchObject({ redirect: "error", credentials: "omit", signal })
    return response()
  }, signal)
  expect(preview).toEqual({ title: "X 公开帖", owner: "公开作者 (@Example)", desc: "同一条 & 正文 续句", link: post })
  for (const changes of [
    { url: post.replace("/123", "/456") }, { author_url: "https://x.com/wrong" }, { url: "https://r.com/Example/status/123" },
    { html: `<blockquote class="twitter-tweet"><p>推荐</p><a href="${post.replace("/123", "/456")}">错帖</a></blockquote>` },
    { html: `<iframe src="${post}"></iframe>` }, { provider_name: "other" },
  ]) expect(await getOfficialLink(target, async () => response(changes), signal)).toBeUndefined()
  await expect(getOfficialLink(target, async () => Response.redirect("https://x.com/"), signal)).rejects.toThrow()
  await expect(getOfficialLink(target, async () => new Response(null, { status: 403 }), signal)).rejects.toThrow()
})

test("Media 实际分发 X 来源，群权限、旧信任边界与私聊开关在请求前生效", async () => {
  const controller = new AbortController()
  let enabled = true, privateAccess = false, calls = 0, accessible = true
  const module = await createModule({ lockFile, signal: controller.signal, officialLinks: {
    settings: async trust => {
      expect(trust === false || trust === "x").toBe(true)
      return { youtube: true, youtubeMusic: true, telegram: true, x: enabled, v2ex: true, articles: true, private: privateAccess,
        trustedXUsers: ["9001"], trustedTelegramUsers: ["9002"] }
    },
    async fetcher(url) {
      calls++
      expect(url.hostname).toBe("publish.x.com")
      return accessible ? response() : new Response(null, { status: 403 })
    },
    async render(template, fields) {
      expect(template).toBe("bilibili-info")
      expect(fields).toMatchObject({ title: "X 公开帖", owner: "公开作者 (@Example)", id: "X · 123", showStats: false })
      return Buffer.from("skia fixture")
    },
  } })
  const registry = new CommandRegistry()
  registry.registerModule({ name: "@lotus-yunzai/media", ...module })
  const dispatch = (source: MessageEvent, block = false) =>
    registry.dispatchFallback(source, names => !block || !names.includes("[media] X 预览"), () => source.isMaster)
  const expected = [{ type: "image", file: Buffer.from("skia fixture") }, { type: "text", text: post }] as const
  const privateEvent = event(post, { message_type: "private", isPrivate: true, isGroup: false })
  try {
    expect(await dispatch(event(post), true)).toBeUndefined()
    expect(await dispatch(privateEvent)).toBeUndefined()
    expect(await dispatch(event(post, { user_id: 9002 }))).toBe("你没有权限使用此命令。")
    enabled = false
    expect(await dispatch(event(post))).toBeUndefined()
    expect(calls).toBe(0)
    enabled = true
    expect(await dispatch(event(legacyLink))).toEqual(expected)
    expect(await dispatch(event(post, { user_id: 9002, isMaster: true }))).toEqual(expected)
    privateAccess = true
    expect(await dispatch(privateEvent)).toEqual(expected)
    accessible = false
    expect(await dispatch(event(post))).toBe("X 暂无法读取公开预览。\n" + post)
    expect(calls).toBe(4)
  } finally { controller.abort(); await module.dispose() }
})

test("X 从旧 Twitter 屏蔽与旧信任键继承；面板保存独立开关及名单", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-x-preview-"))
  try {
    const root = pathToFileURL(dir + "/")
    const data = join(dir, "data")
    const old = join(dir, "backup/plugins/rconsole-plugin/config")
    await mkdir(old, { recursive: true })
    await writeFile(join(old, "tools.yaml"), "globalBlackList: [Twitter]\nprivateResolve: true\n")
    const keys: string[] = []
    const settings = createOfficialLinkSettings(data, root, () => ({ async get(key) {
      keys.push(key)
      return '[8001,"8002"]'
    } }))
    expect(await settings.settings("x")).toMatchObject({ x: false, telegram: true, private: true,
      trustedXUsers: ["8001", "8002"], trustedTelegramUsers: [] })
    const { configInfo } = supportGuoba(data, undefined, root)
    expect(configInfo.schemas).toContainEqual(expect.objectContaining({ field: "officialLinks.x", component: "Switch" }))
    const context = { Result: { ok: () => 200, error: (_: string, status: number) => status } }
    expect(await configInfo.setConfigData({ "officialLinks.x": true, "officialLinks.trustedXUsers": ["9001"] }, context)).toBe(200)
    expect(await configInfo.getConfigData()).toMatchObject({ officialLinks: { x: true, trustedXUsers: ["9001"] } })
    expect(await settings.settings("telegram")).toMatchObject({ x: true, trustedTelegramUsers: ["8001", "8002"], trustedXUsers: [] })
    expect(await configInfo.setConfigData({ "officialLinks.trustedXUsers": [] }, context)).toBe(200)
    expect(await settings.settings("x")).toMatchObject({ x: true, trustedXUsers: [] })
    expect(keys).toEqual(["Yz:rconsole:tools:whitelist", "Yz:rconsole:tools:whitelist"])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
