import { expect, test } from "bun:test"
import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { createMediaEnvironment } from "./command.ts"

const commands = ["#初始化环境", "#初始化工具环境", "#初始化签到环境"]
const config = {
  tools: { dir: "/fixture/tools" }, tuneweave: { api_url: "https://fixture.invalid" },
  bilibili: {}, douyin: { enable: false, request_timeout_ms: 250 }, music: {}, netease_partner: {},
  permissions: { scopes: {
    "bilibili.download": { policy: "inherit" }, "douyin.download": { policy: "inherit" },
    "bilibili.login": { policy: "master_only" }, "tools.install": { policy: "master_only" },
  } },
}

const context = (reply: MessageFallbackContext["reply"], overrides: Partial<MessageFallbackContext> = {}): MessageFallbackContext => ({
  message_type: "private", message_id: 1, self_id: 2, user_id: 3, sender: { user_id: 3 },
  isMaster: true, isBotMaster: (id) => id === 3, canManagePackages: true, normalizedMessage: commands[0]!, reply,
  ...overrides,
})

test("三个环境入口先发准备消息，实时报告 FFmpeg 与 TuneWeave，最后发结果卡", async () => {
  const release = Promise.withResolvers<void>()
  const downloading = Promise.withResolvers<void>()
  const received: unknown[] = []
  const controller = new AbortController()
  const png = Buffer.from("fixture")
  const command = createMediaEnvironment({ signal: controller.signal }, {
    loadConfig: async () => config,
    async prepareTools(settings, progress, signal) {
      expect(settings).toBe(config.tools)
      expect(signal).toBe(controller.signal)
      expect(received).toEqual(["[media] 正在检查媒体环境，补齐缺失组件并检查更新。"])
      await progress("工具链：正在下载 FFmpeg")
      downloading.resolve()
      await release.promise
      return { ok: true, skipped: false, binDir: "/fixture", items: [{ name: "ffmpeg", ok: true, status: "installed", path: "/fixture/ffmpeg" }] }
    },
    async prepareTuneWeave(settings, progress, signal) {
      expect(settings).toBe(config.tuneweave)
      expect(signal).toBe(controller.signal)
      expect(received.slice(-2)).toEqual(["[media] FFmpeg：已安装", "[media] 正在检查 TuneWeave 服务。"])
      await progress("正在启动本机 TuneWeave 服务。")
      return { ok: true, reachable: true, version: "1.2.3", requiredVersion: "1.0.0", requiresUpdate: false,
        apiUrl: "https://fixture.invalid", message: "检查完成", capabilities: [], already: true }
    },
    async render(card) {
      expect(received.at(-1)).toBe("[media] TuneWeave：1.2.3")
      expect(card).toEqual({ title: "媒体环境", subtitle: "检查完成", items: [
        { label: "FFmpeg", value: "已安装" }, { label: "TuneWeave", value: "1.2.3" },
      ] })
      return png
    },
  })
  expect(commands.every(command.matches)).toBe(true)
  const request = command.fallback(commands[1]!, context(message => { received.push(message); return true }))
  await downloading.promise
  expect(received).toEqual(["[media] 正在检查媒体环境，补齐缺失组件并检查更新。", "[media] 工具链：正在下载 FFmpeg"])
  release.resolve()
  expect(await request).toEqual([])
  expect(received.at(-1)).toEqual({ type: "image", file: png })
})

test("权限拦在回执和工具动作前，进度发送失败不终止检查，失败汇总有文字兜底", async () => {
  const received: unknown[] = []
  let reads = 0
  let steps = 0
  const command = createMediaEnvironment({}, {
    loadConfig: async () => { reads++; return config },
    async prepareTools(_settings, progress) {
      steps++
      await progress("工具链：检查 FFmpeg")
      return { ok: false, skipped: false, binDir: "/fixture", items: [{ name: "ffmpeg", ok: false, reason: "校验失败" }] }
    },
    async prepareTuneWeave() { steps++; throw new Error("服务暂不可用") },
    async render() { throw new Error("Skia fixture unavailable") },
  })
  const reply = (message: unknown) => {
    received.push(message)
    throw new Error("发送通道暂不可用")
  }
  expect(await command.fallback(commands[0]!, context(reply, { isDelegated: true }))).toContain("只有机器人主人")
  expect(await command.fallback(commands[0]!, context(reply, { canManagePackages: undefined }))).toContain("只有机器人主人")
  expect(reads).toBe(0)
  expect(steps).toBe(0)
  expect(received).toEqual([])

  expect(await command.fallback(commands[2]!, context(reply))).toBe("媒体环境 · 存在失败\nFFmpeg：失败：校验失败\nTuneWeave：失败：服务暂不可用")
  expect(steps).toBe(2)
  expect(received).toEqual([
    "[media] 正在检查媒体环境，补齐缺失组件并检查更新。", "[media] 工具链：检查 FFmpeg",
    "[media] FFmpeg：失败：校验失败", "[media] 正在检查 TuneWeave 服务。", "[media] TuneWeave：失败：服务暂不可用",
  ])
})

test("宿主停止时结束当前准备，不启动下一个工具或发送最终卡", async () => {
  const controller = new AbortController()
  const replies: unknown[] = []
  const command = createMediaEnvironment({ signal: controller.signal }, {
    loadConfig: async () => config,
    async prepareTools(_settings, progress, signal) {
      controller.abort()
      await progress("应该静默的回执")
      signal?.throwIfAborted()
      throw new Error("missing abort signal")
    },
    async prepareTuneWeave() { throw new Error("unexpected TuneWeave action") },
    async render() { throw new Error("unexpected card") },
  })
  expect(await command.fallback(commands[0]!, context(message => { replies.push(message); return true }))).toEqual([])
  expect(replies).toEqual(["[media] 正在检查媒体环境，补齐缺失组件并检查更新。"])
})

test("三个整体初始化入口同时准备验证码模型，沿用权限和取消信号", async () => {
  for (const name of commands) {
    const received: unknown[] = []
    const controller = new AbortController()
    let downloads = 0
    const command = createMediaEnvironment({ signal: controller.signal }, {
      loadConfig: async () => config,
      prepareTools: async () => ({ ok: true, skipped: true, binDir: "/fixture", items: [] }),
      prepareTuneWeave: async () => ({ ok: true, reachable: true, version: "1.2.3", requiredVersion: "1.0.0", requiresUpdate: false,
        apiUrl: "https://fixture.invalid", message: "检查完成", capabilities: [], already: true }),
      async prepareCaptcha(signal) { expect(signal).toBe(controller.signal); downloads++ },
      render: async () => { throw new Error("fixture no image") },
    })
    expect(await command.fallback(name, context(() => true, { canManagePackages: undefined }))).toContain("只有机器人主人")
    expect(downloads).toBe(0)
    const reply = await command.fallback(name, context(message => { received.push(message); return true }))
    expect(reply).toContain("媒体环境 · 检查完成")
    expect(downloads).toBe(1)
    expect(received).toContain("[media] 验证码模型：已准备完成。")
  }
})

test("模型失败保留媒体结果并明确文字提示；取消停止结果发送", async () => {
  for (const mode of ["fail", "cancel"] as const) {
    const received: unknown[] = []
    const controller = new AbortController()
    let tools = 0, tune = 0, renders = 0
    const command = createMediaEnvironment({ signal: controller.signal }, {
      loadConfig: async () => config,
      prepareTools: async () => { tools++; return { ok: true, skipped: false, binDir: "/fixture", items: [] } },
      prepareTuneWeave: async () => { tune++; return { ok: true, reachable: true, version: "1.2.3", requiredVersion: "1.0.0", requiresUpdate: false,
        apiUrl: "https://fixture.invalid", message: "检查完成", capabilities: [], already: true } },
      async prepareCaptcha() { if (mode === "cancel") controller.abort(); throw new Error("private source error") },
      render: async () => { renders++; return Buffer.from("fixture") },
    })
    const reply = await command.fallback(commands[0]!, context(message => { received.push(message); return true }))
    expect(tools).toBe(1); expect(tune).toBe(1)
    if (mode === "cancel") { expect(reply).toEqual([]); expect(renders).toBe(0) }
    else {
      expect(reply).toBe("验证码模型准备失败，请重新发送初始化指令重试。")
      expect(renders).toBe(1)
      expect(JSON.stringify(received)).not.toContain("private source error")
    }
  }
})
