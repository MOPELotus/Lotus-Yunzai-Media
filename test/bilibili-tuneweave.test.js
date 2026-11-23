import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BilibiliService, quotedBiliCardLink } from "../services/bilibili/service.ts"

const bvid = "BV17x411w7KC"
const ref = "bilibili:bvid:" + bvid
const link = "https://www.bilibili.com/video/" + bvid
const video = { ref, title: "合成稿件", duration_ms: 300_000, extensions: { bvid, aid: 170001 } }
const parts = [1, 2, 3].map(page => ({ id: "cid:" + (100 + page), page, title: "片段 " + page,
  video_ref: ref, duration_ms: 5000 * page }))
const ok = (data, alias) => Response.json({ ok: true, data, meta: { platform: "bilibili", ...(alias && { account: alias }) } })
const absent = () => Response.json({ ok: false, error: { code: "authentication_required" } }, { status: 401 })

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
