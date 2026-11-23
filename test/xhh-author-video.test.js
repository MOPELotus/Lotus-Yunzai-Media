import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { lockFile } from "../../../lib/file-lock.ts"
import { settingsFor } from "../services/subscriptions/config.ts"
import { createAuthorVideoModule } from "../services/subscriptions/xhh-author-command.ts"
import { createAuthorArchive } from "../services/subscriptions/xhh-author-source.ts"
import { createAuthorVideoStore } from "../services/subscriptions/xhh-author-store.ts"

const uid = "12345"
const group = { bot: "99", chat: "77" }
const time = 1_796_000_000
const original = { id: "123", uid, author: "测试作者", type: "DYNAMIC_TYPE_AV", content: "", title: "新投稿",
  images: [], url: "https://www.bilibili.com/video/BV1dAxE6VErW", createdAt: time + 6 }
const fakeRedis = declarations => ({
  get: async key => declarations.get(key) ?? null,
  async eval(script, { keys, arguments: args }) {
    if (script.includes("local claimed")) {
      const results = []
      for (let index = 0; index < keys.length / 2; index++) {
        const [legacy, journal] = keys.slice(index * 2, index * 2 + 2)
        if (declarations.has(legacy) || declarations.has(journal)) continue
        declarations.set(legacy, args[index + 1])
        declarations.set(journal, args[index + 1])
        results.push(index + 1)
      }
      return results
    }
    for (let index = 0; index < keys.length / 2; index++) {
      const [legacy, journal] = keys.slice(index * 2, index * 2 + 2)
      if (declarations.get(journal) !== args[index + 1]) continue
      if (args[0] === "rejected") {
        declarations.delete(legacy)
        declarations.delete(journal)
      } else {
        declarations.set(legacy, "1")
        declarations.set(journal, args[0])
      }
    }
    return 1
  },
})

test("旧投稿首条使用官方作者归档及公开签名字段，拒绝错作者的结果", async () => {
  let author = uid
  const requests = []
  const source = createAuthorArchive(async (path, params) => {
    requests.push({ path, params })
    if (path === "/x/web-interface/nav") return { wbi_img: {
      img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
      sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
    } }
    return { list: { vlist: [{ mid: author, bvid: "BV1dAxE6VErW", created: time - 1, author: "测试作者",
      title: "刚上传的视频", pic: "//i0.hdslb.com/bfs/archive/test.jpg" }] } }
  }, () => time * 1000)
  expect(await source(uid)).toMatchObject({ uid, createdAt: time - 1, id: "BV1dAxE6VErW",
    url: "https://www.bilibili.com/video/BV1dAxE6VErW", cover: "https://i0.hdslb.com/bfs/archive/test.jpg" })
  expect(requests).toEqual([
    { path: "/x/web-interface/nav", params: {} },
    { path: "/x/space/wbi/arc/search", params: { mid: uid, order: "pubdate", pn: "1", ps: "1",
      wts: String(time), w_rid: "3506f298edff1247e787d6eacdf92408" } },
  ])
  author = "54321"
  await expect(source(uid)).rejects.toThrow("作者不匹配")
  expect(requests.filter(request => request.path === "/x/web-interface/nav")).toHaveLength(1)
})

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "lotus-author-video-"))
  const directory = join(root, "data")
  const declarations = new Map()
  const redis = fakeRedis(declarations)
  const sent = []
  const owner = { message_type: "group", self_id: 99, group_id: 77, user_id: 42, isBotMaster: () => false,
    member: { is_admin: true, is_owner: false } }
  let posts = [], status = "confirmed", enabled = true, wall = time, quoted = 0, profiles = 0
  const create = () => createAuthorVideoModule({ directory, lockFile,
    settings: async () => settingsFor({ pushStatus: enabled, pushTaskLog: false, getDataRandomDelay: 0 }),
    provider: { id: "bilibili", label: "B 站", typeNames: {},
      profile: async value => { profiles++; return { uid: value, name: "测试作者" } }, fetchPosts: async () => posts },
    getRedis: () => redis, now: () => wall * 1000,
    notifications: () => [{ botId: 99,
      isGroupMember: async (g, b) => g === 77 && b === 99,
      async sendGroup(g, message) { sent.push([g, message]); return status },
    }],
    render: async (_, post) => [post.title],
    quotedAuthor: async () => { quoted++; return uid },
  })
  const module = create()
  const command = (text, change) => module.fallback(text, { ...owner, ...change })
  try {
    return await callback({ root, directory, owner, module, command, sent, declarations, create,
      modify: input => { ({ posts = posts, status = status, enabled = enabled, wall = wall } = input) },
      calls: () => ({ quoted, profiles }) })
  } finally {
    await module.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

test("B 站投稿只取已订作者的新视频，原首帖、转发、异人及未知回执都不重复发", () => fixture(async context => {
  const { directory, command, module, sent, declarations, create, modify, calls } = context
  expect(await command("#订阅B站视频推送 " + uid, { member: undefined })).toContain("群主")
  expect(await command("#订阅B站视频推送 " + uid, { isDelegated: true })).toBeUndefined()
  expect(calls()).toEqual({ quoted: 0, profiles: 0 })
  expect(await command("#订阅B站视频推送", { reply_id: 9 })).toContain("测试作者")
  expect(calls()).toEqual({ quoted: 1, profiles: 1 })
  expect(await command("#B站视频推送列表")).toContain("12345")
  expect(await command("#B站视频推送列表", { self_id: 98 })).toContain("没有")
  modify({ posts: [{ ...original, createdAt: time }] })
  await module.run()
  expect(sent).toEqual([])

  modify({ wall: time + 12, status: "unknown", posts: [
    { ...original, id: "120", title: "较旧投稿", createdAt: time + 4 },
    { ...original, id: "850", uid: "678", title: "其他作者", createdAt: time + 12 },
    { ...original, id: "900", type: "DYNAMIC_TYPE_FORWARD", title: "转发视频", createdAt: time + 12 },
    original,
  ] })
  const pushed = await module.run()
  expect(pushed.unknown).toBe(1)
  expect(sent).toEqual([[77, "新投稿"]])
  expect((await createAuthorVideoStore(directory, lockFile).routes())[0]).toMatchObject({ uid, createdAfter: original.createdAt })
  declarations.clear()
  const restarted = create()
  try {
    expect((await restarted.run()).unknown).toBe(0)
    expect(sent).toHaveLength(1)
    expect(await command("#删除B站视频推送 " + uid)).toContain("已取消")
    expect(await command("#B站视频推送列表")).toContain("没有")
  } finally {
    await restarted.dispose()
  }
}))

test("只在本群主管主动认领时承接旧 YAML，按作者保留时间并保持旧文件原样", () => fixture(async context => {
  const { directory, command, root, modify, module, sent } = context
  const archive = join(root, "backup", "plugins", "xhh", "config")
  await mkdir(archive, { recursive: true })
  const oldYaml = `12345: [77, 89]\n12345_time: ${time - 20}\n678: [77]\n998: [89]\n888: []\n`
  const path = join(archive, "bili_group.yaml")
  await writeFile(path, oldYaml)
  const store = createAuthorVideoStore(directory, lockFile)
  expect(await store.routes()).toEqual([])
  expect(await command("#迁移B站视频推送", { member: undefined })).toContain("群主")
  expect(await command("#迁移B站视频推送")).toContain("机器人 QQ")
  expect(await command("#迁移B站视频推送 98")).toBeUndefined()
  expect(await command("#迁移B站视频推送 99")).toContain("迁移 2 条")
  expect(await command("#迁移B站视频推送 99")).toContain("迁移 0 条")
  expect((await store.routes()).map(({ uid, createdAfter, chat, bot }) => ({ uid, createdAfter, chat, bot }))).toEqual([
    { ...group, uid: "678", createdAfter: time },
    { ...group, uid, createdAfter: time - 20 },
  ])
  expect(await readFile(path, "utf8")).toBe(oldYaml)
  modify({ enabled: false, posts: [{ ...original, createdAt: time - 10 }] })
  await module.run()
  expect(sent).toEqual([])
  modify({ enabled: true, status: "rejected" })
  expect((await module.run()).rejected).toBe(1)
  modify({ status: "confirmed" })
  expect((await module.run()).confirmed).toBe(1)
  expect(sent).toHaveLength(2)
}))
