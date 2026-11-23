import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { MessageFallbackContext } from "../../../lib/commands.ts"
import { createKuaishouCommands, parseKuaishouH5 } from "../services/kuaishou/command.ts"
import { createKuaishouSettings } from "../services/kuaishou/settings.ts"
import { supportGuoba } from "../guoba-settings.ts"
import type { loadGlobalConfig } from "../core/config/global.ts"

const id = "3xburnkmj3auazc"
const source = `https://v.m.chenzhongtech.com/fw/photo/${id}`
const desktop = `https://www.kuaishou.com/short-video/${id}`
const video = "https://txmov2.a.kwimgs.com/upic/original.mp4"
const fixture = { share_info: `userId=7&photoId=${id}`, photoStatus: 0, type: 1, photoType: "VIDEO", caption: "原帖",
  mainMvUrls: [{ url: "https://unauthorized.test/wrong.mp4" }, { url: video }], coverUrls: [{ url: "https://p23.a.yximgs.com/cover.jpg" }] }
const page = (photo = fixture) => `<script>window.INIT_STATE = ${JSON.stringify({ key: { photo } })};</script>`
const config = (async () => ({ tools: {}, permissions: {} })) as typeof loadGlobalConfig

test("快手精确比对官方 H5 公开号码，下载与未知送达只尝试一次", async () => {
  expect(parseKuaishouH5(page(), id)?.video?.href).toBe(video)
  expect(parseKuaishouH5(page(), "3xunknown")).toBeUndefined()
  expect(parseKuaishouH5(page({ ...fixture, photoStatus: 1 }), id)).toBeUndefined()
  expect(parseKuaishouH5(page({ ...fixture, photoType: "PICTURE" }), id)?.video).toBeUndefined()
  const root = await mkdtemp("/tmp/lotus-ks-fixture-")
  const tasksDir = join(root, "tasks")
  const data = join(root, "data")
  const legacy = join(root, "backup/plugins/rconsole-plugin/config")
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, "tools.yaml"), 'privateResolve: true\nglobalBlackList: ["通用（包含快手等）"]\n')
  const settings = createKuaishouSettings(data, root)
  const panel = supportGuoba(data, undefined, undefined, undefined, config, settings).configInfo
  const Result = { ok: () => 200, error: (_: string, status: number) => status }
  const seen: string[] = []
  const messages: unknown[] = []
  let deliveries = 0
  const command = createKuaishouCommands({ settings, tasksDir, loadConfig: config, render: async () => Buffer.from([1]),
    fetch: async (url, init) => {
      seen.push(url)
      expect(init?.redirect).toBe("manual")
      expect(init?.credentials).toBe("omit")
      if (url === source) {
        expect(init?.headers?.["User-Agent"]).toContain("Mobile")
        expect(init?.headers?.Accept).toBeUndefined()
        return new Response(page())
      }
      if (url === video) return new Response(Buffer.from("0000ftypisom"))
      throw new Error(url)
    },
  })
  try {
    const context = { normalizedMessage: desktop, message_type: "group", isMaster: false, isBotMaster: () => false, group_id: 1,
      reply(message: unknown) { messages.push(message); return true }, async deliverMedia() { deliveries++; return "unknown" } } as MessageFallbackContext
    expect(await panel.getConfigData()).toMatchObject({ kuaishou: { enable: false, private: true } })
    expect(await command.fallback(desktop, context)).toBeUndefined()
    expect(await panel.setConfigData({ "kuaishou.enable": true, "kuaishou.private": false }, { Result })).toBe(200)
    expect(await command.fallback(desktop, { ...context, message_type: "private" })).toBeUndefined()
    const result = await command.fallback(desktop, context)
    expect(seen).toEqual([source])
    if (!result || typeof result !== "object" || !("onDelivered" in result) || result.type !== "delivery") throw new Error("missing media")
    await result.onDelivered(2)
    await result.onDelivered(2)
    expect(seen).toEqual([source, video])
    expect(deliveries).toBe(1)
    expect(messages).toEqual(["视频送达未确认，请核对当前会话。"])
    expect(await readdir(tasksDir)).toEqual([])
  } finally {
    await command.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
