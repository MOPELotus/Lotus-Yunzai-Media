import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CommandRegistry } from "../../../lib/commands.ts"
import { closeStorage, connectStorage } from "@lotus-yunzai/storage"
import { supportGuoba } from "../guoba-settings.ts"
import { createOfficialVideoCommands } from "../services/official-video/index.ts"
import { createOfficialVideoFeed } from "../services/official-video/feed.ts"
import { createOfficialVideoSettings, officialVideoGames } from "../services/official-video/settings.ts"

const time = 1_794_000_100
const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
function feedFixture(requests, text = "样本文字") {
  return createOfficialVideoFeed(async (url, options) => {
    expect(options.redirect).toBe("error")
    expect(options.credentials).toBe("omit")
    requests.push(url.href)
    if (url.hostname === "upload-bbs.miyoushe.com") return new Response(png, { headers: { "content-type": "image/png" } })
    expect(url.hostname).toBe("bbs-api.miyoushe.com")
    expect(url.pathname).toBe("/post/wapi/userPost")
    expect(url.searchParams.get("size")).toBe("20")
    const id = url.searchParams.get("uid")
    const mkPost = (at, title) => ({ post: { post_id: id, created_at: at, subject: title,
      structured_content: JSON.stringify([{ insert: text }, { insert: { ignored: true } }]), cover: "https://upload-bbs.miyoushe.com/fixture.png" },
    vod_list: [{ resolutions: [{ url: "https://vod.example.test/low.mp4", label: "480p" },
      { url: "https://vod.example.test/high.mp4", label: "1080p", size: "2097153" }, { url: "javascript:fixture" }] }] })
    return Response.json({ retcode: 0, data: { list: [mkPost(time - 1, "旧视频"), mkPost(time, "最新视频")] } })
  }, () => time * 1000)
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "lotus-official-video-"))
  const directory = join(root, "data")
  try { await run({ root, directory, config: createOfficialVideoSettings(directory, root) }) }
  finally { await rm(root, { recursive: true, force: true }) }
}

test("官号视频面板继承原群配置、封面和附加游戏，编辑后保留旧源字节", async () => fixture(async ({ root, directory, config }) => {
  const legacy = join(root, "backup/plugins/xhh/config")
  await mkdir(legacy, { recursive: true })
  const previous = "forwardMsg: false\ncover: true\nbh3: true\ngroup_config: {777: [sr, zzz]}\n"
  await writeFile(join(legacy, "other.yaml"), previous)
  await writeFile(join(legacy, "config.yaml"), "groups: [777]\n")
  const form = supportGuoba(directory, config).configInfo
  expect((await form.getConfigData()).officialVideo).toEqual({ groups: ["777"], group_config: ["777: sr, zzz"],
    forwardMsg: false, cover: true, bh3: true, by: false, xbgd: false })
  const Result = { ok: () => 200, error: (_msg, status) => status }
  expect(await form.setConfigData({ "officialVideo.group_config": ["bad: sr"] }, { Result })).toBe(422)
  expect(await form.setConfigData({ "officialVideo.groups": [], "officialVideo.group_config": ["987: bh3, by"],
    "officialVideo.cover": false, "officialVideo.by": true, "officialVideo.xbgd": true }, { Result })).toBe(200)
  expect(await config.settings()).toMatchObject({ groups: [], forward: false, cover: false,
    games: ["gs", "sr", "zzz", "bh3", "by", "xbgd"] })
  expect([...((await config.settings()).muted.get(987) ?? [])]).toEqual(["bh3", "by"])
  expect(await readFile(join(legacy, "other.yaml"), "utf8")).toBe(previous)
}))

test("宿主实际指令只回当前会话、不动旧定时位点，群内过滤并保留原视频字段", async () => fixture(async ({ config }) => {
  const requests = [], sent = []
  await config.save({ group_config: ["777: sr, zzz"], cover: false })
  let scheduledReads = 0
  const commands = createOfficialVideoCommands({}, { config, feed: feedFixture(requests, "正文".repeat(302)),
    getRedis: () => { scheduledReads++; throw Error("手动查询不应读取定时位点") }, wait: async () => {} })
  try {
    const registry = new CommandRegistry()
    registry.registerModule({ name: "@lotus-yunzai/media", commands: {}, fallback: commands.fallback })
    const dispatch = () => registry.dispatchFallback({ msg: "#最新视频", message_type: "group", group_id: 777, user_id: 42, isMaster: false,
      reply: reply => { sent.push(reply); return true } }, () => true, () => false)
    const first = await dispatch()
    expect(first).toMatchObject({ type: "forward", nodes: [expect.any(Array), expect.stringContaining("正文")] })
    expect(first.nodes[0]).toEqual([expect.stringContaining("画质大小：1080p · 约 3 MB"), "\n封面：\n",
      { type: "image", file: png }, "\n视频链接：https://vod.example.test/high.mp4"])
    expect(requests.some(url => url.includes("uid=" + officialVideoGames.sr.uid))).toBe(false)
    expect(requests.some(url => url.includes("p_30"))).toBe(true)
    expect(sent).toEqual([])
    await config.save({ forwardMsg: false, cover: true })
    expect(await dispatch()).toEqual([])
    expect(sent).toHaveLength(2)
    expect(requests.at(-1)).toBe("https://upload-bbs.miyoushe.com/fixture.png")
    expect(scheduledReads).toBe(0)
  } finally { await commands.dispose() }
}))

const valkey = Bun.which("valkey-server")
test.skipIf(!valkey)("官号定时只发当前授权群，真实 Valkey 继承旧时间并持久去重", async () => fixture(async ({ config }) => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  const process = Bun.spawn([valkey, "--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no"],
    { stdout: "pipe", stderr: "inherit" })
  const timeout = setTimeout(() => process.kill("SIGKILL"), 3000)
  const reader = process.stdout.getReader()
  const decode = new TextDecoder()
  let startup = "", redis
  try {
    while (!startup.includes("Ready to accept connections")) {
      const frame = await reader.read()
      if (frame.done) throw Error("隔离 Valkey 未启动")
      startup += decode.decode(frame.value, { stream: true })
    }
    redis = await connectStorage(`redis://127.0.0.1:${port}/3`)
    await redis.set("xhh_vid:gs", String(time))
    const requests = [], delivery = [], waited = []
    await config.save({ groups: ["777", "888"], group_config: ["777: zzz", "888: sr, zzz"] })
    let mode = "rejected", allowed = true, task
    const session = { botId: 99, async isGroupMember(group) { return group === 777 || group === 888 },
      async sendForward({ groupId }, nodes) { delivery.push({ groupId, nodes }); return mode } }
    const commands = createOfficialVideoCommands({ subscriptionTransport: () => [session], allowOfficialVideoGroup: () => allowed,
      mediaRuntime: { whenReady() { throw Error("应走宿主调度") }, registerOfficialVideoTask(cron, run) {
        expect(cron).toBe("30 */3 * * * *")
        task = run
        return () => { task = undefined }
      } } }, { config, feed: feedFixture(requests), getRedis: () => redis, wait: async ms => { waited.push(ms) } })
    const receipt = `lotus:media:official-video:777:sr:${officialVideoGames.sr.uid}`
    const cutoff = "lotus:media:official-video:777:sr:latest"
    try {
      expect(typeof task).toBe("function")
      await task()
      expect(delivery.map(row => row.groupId)).toEqual([777])
      expect(await redis.get(receipt)).toBeNull()
      mode = "unknown"
      await task()
      expect(delivery).toHaveLength(2)
      expect(delivery[0].nodes[0][0]).toContain("游戏：星铁")
      expect(await redis.get(receipt)).toBe("unknown")
      expect(await redis.get(cutoff)).toBe(String(time))
      await redis.del(receipt)
      await task()
      expect(delivery).toHaveLength(2)
      expect(await redis.get("xhh_vid:gs")).toBe(String(time))
      allowed = false
      await config.save({ group_config: [] })
      await task()
      expect(delivery).toHaveLength(2)
      expect(waited).toEqual([])
    } finally { await commands.dispose() }
    expect(task).toBeUndefined()
  } finally {
    await closeStorage()
    clearTimeout(timeout)
    process.kill()
    await process.exited
    reader.releaseLock()
  }
}))
