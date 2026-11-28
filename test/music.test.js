import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import YAML from "yaml"
import { MusicService, musicSessionKey, musicShare } from "../services/music/service.ts"
import { createMusicCommands } from "../services/music/command.ts"
import { readMusicAccounts, saveMusicAccount } from "../services/music/accounts.ts"
import { readPartnerLog, partnerLogNodes } from "../services/music/partner-log.ts"
import { TuneWeaveService } from "../services/tuneweave/service.ts"
import { NeteaseCloudLibrary } from "../services/music/cloud-service.ts"
import { readQqCollection } from "../services/music/personal.ts"

const temp = []
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "lotus-music-tests-"))
  temp.push(dir)
  return dir
}
afterEach(async () => Promise.all(temp.splice(0).map(dir => rm(dir, { recursive: true, force: true }))))

const track = {
  ref: "netease:track:1042", platform: "netease", name: "合成曲目",
  id: "1042", artists: [{ name: "合成作者" }], album: { cover_url: "https://p1.music.126.net/cover.png" },
}

test("合伙人日志沿用最近文件和历史命名，读取失败不误报为空",async()=>{
  const dir=await directory()
  const newest=join(dir,"nep-latest.json")
  const dated=report=>JSON.stringify({accounts:[],time:report})
  expect(await readPartnerLog(join(dir,"missing"))).toBeNull()
  await writeFile(join(dir,"nep-202601010100.json"),dated("旧时间"))
  const newer=join(dir,"nep-202601020100.json")
  await writeFile(newer,dated("最新历史"))
  await writeFile(join(dir,"nep-z.json"),dated("无关文件"))
  expect((await readPartnerLog(dir)).time).toBe("最新历史")
  await writeFile(newest,dated("当前日志"))
  expect((await readPartnerLog(dir)).time).toBe("当前日志")
  expect(await readFile(newest,"utf8")).toBe(dated("当前日志"))
  await writeFile(newest,"{不可读")
  await expect(readPartnerLog(dir)).rejects.toThrow()
  await rm(newest)
  await symlink(newer,newest)
  await expect(readPartnerLog(dir)).rejects.toThrow()
})

test("合伙人日志按原先顺序投影账号和逐首结果，避开未筛选的错误数据",()=>{
  const account={nickname:"示例账号",uid:"42",success:1,fail:0,attempts:2,details:["读取失败 MUSIC_U=fixture-private"],
    evaluations:[{name:"示例曲目",score:0,extraScore:{作词:8},comment:"纯文字 [CQ:at,qq=all]",status:"success",attempt:2},
      {name:"失败曲目",error:"MUSIC_U=fixture-private",comment:"token=fixture-private",attempt:1},
    ]}
  const nodes=partnerLogNodes({time:"2026-11-20T07:00:00+08:00",trigger:"手动执行",accounts:[account]})
  expect(nodes.slice(0,3)).toEqual([
    {type:"text",text:"合伙人日志 · 2026-11-20T07:00:00+08:00 · 手动执行"},
    {type:"text",text:"示例账号：成功 1 · 失败 0 · 执行 2 轮"},
    {type:"text",text:"歌曲：示例曲目\n主分：0\n子项：作词:8\n乐评：纯文字 [CQ:at,qq=all]\n第 2 轮 · 成功"},
  ])
  expect(nodes[3].text).toContain("第 1 轮 · 失败")
  expect(JSON.stringify(nodes)).not.toContain("fixture-private")
  const many=n=>partnerLogNodes({accounts:[{...account,evaluations:Array(n).fill(account.evaluations[0])}]})
  expect(many(98).at(-1).text).toContain("示例曲目")
  expect(many(99)).toHaveLength(100)
  expect(many(99).at(-1).text).toContain("仅显示前 99 条")
})

test("点歌会话按协议、机器人、群或私聊、发起人隔离", () => {
  const subject = {adapter:undefined,message_type:"group",self_id:99,user_id:42,group_id:77}
  expect(musicSessionKey(subject)).toBe("onebot:99:group:77:42")
  expect(new Set([
    musicSessionKey(subject),
    musicSessionKey({...subject,self_id:98}),
    musicSessionKey({...subject,group_id:78}),
    musicSessionKey({...subject,user_id:43}),
    musicSessionKey({...subject,adapter:"milky"}),
    musicSessionKey({...subject,message_type:"private",group_id:undefined}),
    musicSessionKey({...subject,message_type:"terminal",group_id:undefined}),
  ]).size).toBe(7)
})

test("同号 Milky 私聊不能取消 OneBot 的音乐扫码菜单", async () => {
  const api = { platforms: async () => [{ id: "netease", name: "网易云音乐", capabilities: ["qr_login"] }] }
  const music = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "netease", timeoutMs: 120000 }) })
  const onebot = { message_type: "private", self_id: 99, user_id: 42,
    canManagePackages: true, privateCredentialSignal: new AbortController().signal }
  const milky = { ...onebot, adapter: "milky" }
  try {
    expect(await music.fallback("#音乐登录", onebot)).toContain("请选择扫码平台")
    expect(music.features({ ...milky, normalizedMessage: "#取消" })).toEqual([])
    expect(await music.fallback("#取消", milky)).toBeUndefined()
    expect(await music.fallback("#取消", onebot)).toBe("已取消本次音乐操作。")
  } finally {
    await music.dispose()
  }
})

test("playback isolates platform credentials even with cross-platform fallback", async () => {
  const file = join(await directory(), "accounts.yaml")
  for (const platform of ["netease", "qq", "kugou"]) {
    await saveMusicAccount(platform, { alias: `fixture-${platform}`, uid: "1042", credential: `twc1_${platform}` }, { file })
  }
  for (const platform of ["netease", "qq", "kugou"]) for (const exact of [false, true]) {
    const song = { platform, id: "1042", ref: `${platform}:1042`, name: "fixture" }
    let calls = 0
    const service = new MusicService({ accountsFile: file, tuneweave: { async request(route, options) {
      calls++
      // The server validates every submitted credential before resolving audio.
      if (options.credentials.some(value => value !== `twc1_${platform}`)) {
        throw Object.assign(new Error("unrelated expired credential"), { code: "authentication_required", platform: "other" })
      }
      expect(options.credentials).toEqual([`twc1_${platform}`])
      const query = new URL(route, "http://fixture.invalid").searchParams
      expect(query.get("fallback")).toBe(String(!exact))
      if (!exact) expect(query.get("fallback_platforms").split(",")).not.toContain(platform)
      return { url: "https://audio.example.test/full.wav", trial: false,
        origin_track: song.ref, resolved_track: song.ref, resolved_platform: platform }
    } } })
    expect((await service.resolve(song, { exact })).resolved_track).toBe(song.ref)
    expect(calls).toBe(1)
  }
})

test("搜歌只取所选平台的曲目，播放回退保留卡片的原平台", async () => {
  const file = join(await directory(), "music.yaml")
  await saveMusicAccount("netease", {alias:"lotus-nep-fixture",uid:"1042",credential:""}, {file})
  const searches = []
  const service = new MusicService({ accountsFile:file, tuneweave:{ request:async route => {
    const request = new URL(route,"http://127.0.0.1:7832")
    searches.push(request)
    if (request.pathname === "/v1/search") return {data:[{type:"artist",data:{}},{type:"track",data:track}],accountSelected:true}
    return {url:"https://audio.example.test/test.mp3",resolved_platform:"qq",trial:false}
  } } })
  expect(await service.search("netease", "  合成曲目  ", 2)).toEqual({tracks:[track],accountStatus:"selected"})
  const stream = await service.resolve(track)
  expect(Object.fromEntries(searches[0].searchParams)).toEqual({
    platform:"netease",type:"track",q:"合成曲目",limit:"10",offset:"10",account:"lotus-nep-fixture",
  })
  expect(searches[1].searchParams.get("fallback_platforms")).toBe("qq,kugou,kuwo,migu,soda")
  expect(musicShare(track,stream)?.data).toMatchObject({type:"163",url:"https://music.163.com/#/song?id=1042",title:"合成曲目"})
  expect(musicShare(track,{...stream,headers:{Cookie:"fixture-private"}})).toBeNull()
  expect(musicShare(track,{...stream,url:"/v1/track/private"})).toBeNull()
})

test("点歌只凭本次响应识别已选用账号，访客和未确认账号分别提示", async () => {
  const accountsFile = join(await directory(), "music.yaml")
  const requests = []
  const mock = Bun.serve({ hostname:"127.0.0.1", port:0, fetch(request) {
    const url = new URL(request.url)
    requests.push(url.pathname)
    const platform = url.searchParams.get("platform")
    const query = url.searchParams.get("q")
    const alias = url.searchParams.get("account")
    const headers = query === "凭据轮换" ? {"X-TuneWeave-Updated-Credential":"qq=twc1_rotated"} : {}
    return Response.json({ ok:true, data:[{type:"track",data:track}],
      meta:{platform, account:query === "别名不一致" ? "other-account" : alias} }, {headers})
  } })
  try {
    const service = new MusicService({ accountsFile, tuneweaveConfig:{api_url:`http://127.0.0.1:${mock.port}`} })
    expect((await service.search("qq", "访客")).accountStatus).toBe("unconfigured")
    await saveMusicAccount("netease", {alias:"fixture-netease",uid:"17"}, {file:accountsFile})
    expect((await service.search("netease", "别名匹配")).accountStatus).toBe("selected")
    expect((await service.search("netease", "别名不一致")).accountStatus).toBe("unverified")
    await saveMusicAccount("qq", {alias:"fixture-qq",uid:"18",credential:"twc1_saved"}, {file:accountsFile})
    expect((await service.search("qq", "无凭据确认")).accountStatus).toBe("unverified")
    expect((await service.search("qq", "凭据轮换")).accountStatus).toBe("selected")
    expect((await readMusicAccounts(accountsFile)).qq.credential).toBe("twc1_rotated")
    expect(requests).toEqual(Array(5).fill("/v1/search"))
  } finally { mock.stop(true) }
})

test("试听音源明确拒绝，完整歌曲前不创建媒体任务", async () => {
  const root = await directory()
  const service = new MusicService({accountsFile:join(root,"no-accounts.yaml"),tasksDir:join(root,"tasks"),
    tuneweave:{request:async()=>({url:"https://audio.example.test/trial.mp3",trial:true})}})
  await expect(service.prepare(track)).rejects.toThrow("完整音源")
  expect(await Bun.file(join(root,"tasks/.lotus-media-task.json")).exists()).toBe(false)
})

test("扫码核实平台和别名，合伙人偏好仍按原网易云 UID 保存", async () => {
  const root = await directory()
  const accountsFile = join(root,"music.yaml")
  const partnerAccountsFile = join(root,"partner","accounts.yaml")
  await mkdir(join(root,"partner"))
  await writeFile(partnerAccountsFile, YAML.stringify({accounts:[{
    uid:"1042",nickname:"旧昵称",qq:"42",extraCount:6,comment:false,tuneweave_account:"lotus-nep-42",
  }]}))
  const calls = []
  const service = new MusicService({accountsFile,partnerAccountsFile,tuneweave:{ request:async (route, options) => {
    calls.push([route,options?.body])
    if (route === "/v1/auth/qr") return {transaction_id:"synthetic-qr",url:"https://music.163.com/test-login"}
    if (route === "/v1/auth/qr/synthetic-qr") return {state:"confirmed",profile:{platform:"netease",account:"lotus-nep-42",authenticated:true},caller_credential:{value:"twc1_test_account"}}
    return {platform:"netease",account:"lotus-nep-42",authenticated:true,user_id:"1042",nickname:"新昵称"}
  } } })
  await service.adoptPartnerAccount()
  expect((await readMusicAccounts(accountsFile)).netease.alias).toBe("lotus-nep-42")
  const login = await service.createLogin("netease",42)
  expect(calls[0]).toEqual(["/v1/auth/qr",{platform:"netease",account:"lotus-nep-42",credential_mode:"both"}])
  await service.waitLogin(login)
  expect((await readMusicAccounts(accountsFile)).netease).toEqual({alias:"lotus-nep-42",uid:"1042",nickname:"新昵称",credential:"twc1_test_account",owner:42})
  const partner = YAML.parse(await readFile(partnerAccountsFile,"utf8")).accounts
  expect(partner).toHaveLength(1)
  expect(partner[0]).toMatchObject({uid:"1042",qq:"42",extraCount:6,comment:false,tuneweave_account:"lotus-nep-42"})
})

test("音乐登录与云盘复用同一网易云身份，补全合伙人关联且不申请二维码", async () => {
  const root = await directory()
  const accountsFile = join(root, "music.yaml"), partnerAccountsFile = join(root, "partner.yaml")
  const calls = []
  let uid = "1042"
  let selected = true
  const endpoint = "http://127.0.0.1:7832"
  const signal = new AbortController()
  const service = new MusicService({ accountsFile, partnerAccountsFile,
    tuneweave: { config: { api_url: endpoint }, async request(route, options) {
      const url = new URL(route, endpoint)
      calls.push([url.pathname, url.searchParams.get("account")])
      if (url.pathname === "/v1/capabilities") return [{ platform: "netease", registered: true, capabilities: ["qr_login"] }]
      expect(url.pathname).toBe("/v1/account")
      const alias = url.searchParams.get("account")
      expect(options.accountSelection).toEqual({ platform: "netease", alias })
      expect(options.credentials).toBeUndefined()
      return { accountSelected: selected, data: { platform: "netease", account: alias, authenticated: true, user_id: uid, nickname: "新昵称" } }
    } },
  })
  await saveMusicAccount("netease", { alias: "lotus-nep-42", uid, owner: 42, credential: "twc1_test" }, { file: accountsFile })
  const library = new NeteaseCloudLibrary()
  expect(await library.verify(service, 42, signal.signal)).toMatchObject({ uid, alias: "lotus-nep-42", owner: 42 })
  await expect(library.verify(service, 43, signal.signal)).rejects.toThrow("自己的网易云账号")
  const command = createMusicCommands({ openMusic: async () => ({ api: service, defaultPlatform: "netease", timeoutMs: 120_000 }) })
  const messages = []
  const friend = { message_type: "private", self_id: 99, user_id: 42, canManagePackages: true,
    privateCredentialSignal: signal.signal, reply: async value => { messages.push(value); return true } }
  try {
    expect(await command.fallback("#音乐登录", friend)).toContain("云盘共用登录")
    expect(await command.fallback("1", friend)).toEqual([])
    expect(messages).toEqual([expect.stringContaining("已使用当前网易云登录")])
    expect(await service.partner.loadAccounts()).toMatchObject([{ uid, qq: "42", tuneweave_account: "lotus-nep-42" }])
    expect((await readMusicAccounts(accountsFile)).netease.credential).toBe("twc1_test")
    expect(calls.every(([path]) => path !== "/v1/auth/qr")).toBe(true)
    uid = "2020"
    await expect(service.reuseMusicLogin("netease", 42, signal.signal, true)).rejects.toThrow("账号不一致")
    selected = false
    await expect(service.reuseMusicLogin("netease", 42, signal.signal, true)).rejects.toThrow("未确认")
    expect((await readMusicAccounts(accountsFile)).netease.uid).toBe("1042")
  } finally { await command.dispose() }
})

test("旧合伙人只复用已登录且同 UID 的 TuneWeave 默认别名，不上传明文 Cookie", async () => {
  const root = await directory()
  const accountsFile = join(root, "music.yaml"), partnerAccountsFile = join(root, "partner.yaml")
  const account = { uid: "1042", qq: "42", extraCount: 6, comment: false, cookie: "MUSIC_U=fixture-not-a-secret" }
  await writeFile(partnerAccountsFile, YAML.stringify({ accounts: [account] }))
  let uid = "1000"
  const service = new MusicService({ accountsFile, partnerAccountsFile, tuneweave: { async request(route, options) {
    expect(route).toBe("/v1/account?platform=netease&account=default")
    expect(options.credentials).toBeUndefined()
    expect(options.body).toBeUndefined()
    return { accountSelected: true, data: { platform: "netease", account: "default", authenticated: true, user_id: uid } }
  } } })
  const signal = new AbortController().signal
  expect(await service.reuseMusicLogin("netease", 43, signal, true)).toBe(false)
  await expect(service.reuseMusicLogin("netease", 42, signal, true)).rejects.toThrow("账号不一致")
  expect((await service.partner.loadAccounts())[0].cookie).toBe(account.cookie)
  uid = "1042"
  expect(await service.reuseMusicLogin("netease", 42, signal, true)).toBe(true)
  const [linked] = await service.partner.loadAccounts()
  expect(linked).toMatchObject({ uid, qq: "42", tuneweave_account: "default", extraCount: 6, comment: false })
  expect(linked.cookie).toBeUndefined()
  expect((await readMusicAccounts(accountsFile)).netease).toMatchObject({ uid, alias: "default", owner: 42, credential: "" })
})

test("复用明确过期的网易云或 QQ 登录会先续期同一 UID，再核验是否需要扫码", async () => {
  for (const [platform, alias, caller] of [
    ["netease", "lotus-nep-42", false], ["netease", "lotus-nep-42", true], ["qq", "lotus-music-qq", true],
  ]) {
    const root = await directory()
    const accountsFile = join(root, "music.yaml"), partnerAccountsFile = join(root, "partner.yaml")
    const old = { uid: "1042", alias, owner: 42, credential: caller ? "twc1_original" : "" }
    const calls = []
    let state = "expired"
    let outcome = "success"
    const profile = { platform, account: alias, authenticated: true, user_id: old.uid }
    const service = new MusicService({ accountsFile, partnerAccountsFile, tuneweave: { config: { api_url: "http://127.0.0.1:7832" },
      async request(path, options) {
        calls.push(path.split("?")[0])
        expect(options.accountSelection).toEqual({ platform, alias })
        if (path === "/v1/auth/session/refresh") {
          expect(options.body).toEqual({ platform, account: alias, credential_mode: caller ? "both" : "server" })
          expect(options.credentials).toEqual(caller ? ["twc1_original"] : undefined)
          if (outcome === "network") throw Object.assign(new Error("网络异常"), { code: "tuneweave_unavailable" })
          if (outcome === "expired") throw Object.assign(new Error("已过期"), { code: "authentication_required" })
          if (outcome === "wrong-uid") return { accountSelected: true, data: { ...profile, user_id: "5000" } }
          state = "success"
          return { accountSelected: true, data: { ...profile, ...(caller ? { caller_credential: { platform, value: "twc1_rotated" } } : {}) } }
        }
        return { accountSelected: true, data: state === "success" ? profile : { ...profile, authenticated: false } }
      } },
    })
    const signal = new AbortController().signal
    for (const [result, error] of [["network", "网络异常"], ["wrong-uid", "不一致|无法核实"], ["expired", null], ["success", null]]) {
      outcome = result
      await saveMusicAccount(platform, old, { file: accountsFile })
      calls.length = 0
      if (error) await expect(service.reuseMusicLogin(platform, 42, signal, true)).rejects.toThrow(new RegExp(error))
      else expect(await service.reuseMusicLogin(platform, 42, signal, true)).toBe(result === "success")
      expect(calls).toEqual(result === "success" ? ["/v1/account", "/v1/auth/session/refresh", "/v1/account"]
        : ["/v1/account", "/v1/auth/session/refresh"])
      expect((await readMusicAccounts(accountsFile))[platform].credential).toBe(result === "success" && caller ? "twc1_rotated" : old.credential)
    }
    if (platform === "netease") {
      await saveMusicAccount(platform, old, { file: accountsFile })
      state = "expired"
      calls.length = 0
      expect(await new NeteaseCloudLibrary().verify(service, 42, signal)).toMatchObject({ uid: old.uid, alias })
      expect(calls).toEqual(["/v1/account", "/v1/auth/session/refresh", "/v1/account"])
      expect((await readMusicAccounts(accountsFile)).netease.credential).toBe(caller ? "twc1_rotated" : "")
    }
  }
})

test("酷狗和汽水使用同一登录代际验证账号，并同步服务器已确认的凭据轮换", async () => {
  for (const platform of ["kugou", "soda"]) {
    const root = await directory()
    const accountsFile = join(root, "music.yaml"), alias = "lotus-music-" + platform
    const previous = { uid: "1042", alias, owner: 42, credential: "twc1_old" }
    const profile = { platform, account: alias, authenticated: true, user_id: previous.uid }
    let mode = "success"
    const service = new MusicService({ accountsFile, tuneweave: { config: { api_url: "http://127.0.0.1:7832" },
      async request(route, options) {
        expect(route).toBe("/v1/auth/session/refresh")
        expect(options.body).toEqual({ platform, account: alias, credential_mode: "both" })
        expect(options.credentials).toEqual(["twc1_old"])
        const updated = { platform, credential: "twc1_rotated" }
        if (mode !== "success") {
          options.onCredentialUpdates([updated])
          throw Object.assign(new Error(mode), { code: mode })
        }
        return { accountSelected: true, data: { ...profile, caller_credential: { platform, value: updated.credential } } }
      },
    } })
    const signal = new AbortController().signal
    for (const outcome of ["success", "upstream_error", "authentication_required", "conflict"]) {
      mode = outcome
      await saveMusicAccount(platform, previous, { file: accountsFile })
      if (outcome === "success") expect(await service.reuseMusicLogin(platform, 42, signal, true)).toBe(true)
      else if (outcome === "authentication_required") expect(await service.reuseMusicLogin(platform, 42, signal, true)).toBe(false)
      else await expect(service.reuseMusicLogin(platform, 42, signal, true)).rejects.toThrow(outcome)
      const rotated = outcome === "success" || outcome === "upstream_error"
      expect((await readMusicAccounts(accountsFile))[platform].credential).toBe(rotated ? "twc1_rotated" : "twc1_old")
    }
  }
})

test("云盘列表返回时合伙人绑定已换号，旧结果不能进入缓存", async () => {
  const root = await directory()
  const accountsFile = join(root, "music.yaml"), partnerAccountsFile = join(root, "partner.yaml")
  const alias = "lotus-nep-42", uid = "1042"
  let switched = false
  const service = new MusicService({ accountsFile, partnerAccountsFile, tuneweave: { config: { api_url: "http://127.0.0.1:7832" },
    async request(route, options) {
      const url = new URL(route, "http://127.0.0.1:7832")
      expect(options.accountSelection).toEqual({ platform: "netease", alias })
      if (url.pathname === "/v1/account") return { accountSelected: true,
        data: { platform: "netease", authenticated: true, account: alias, user_id: switched ? "2042" : uid } }
      expect(url.pathname).toBe("/v1/account/cloud/tracks")
      await service.partner.saveAccount({ uid: "2042", qq: 42, tuneweave_account: alias })
      switched = true
      return { accountSelected: true, data: [], pagination: { offset: 0, total: 0, has_more: false } }
    } },
  })
  await service.partner.saveAccount({ uid, qq: 42, tuneweave_account: alias })
  const library = new NeteaseCloudLibrary()
  const signal = new AbortController().signal
  const previous = await library.verify(service, 42, signal)
  await expect(library.list(service, previous, signal)).rejects.toThrow("账号不一致")
  const current = await library.verify(service, 42, signal)
  expect(current.uid).toBe("2042")
  expect(current.key).not.toBe(previous.key)
  await expect(library.assertCurrent(service, previous, signal)).rejects.toThrow("绑定已变更")
})

test("取消与串号确认保留原音乐身份和凭据", async () => {
  const accountsFile = join(await directory(),"music.yaml")
  const current = {alias:"lotus-music-qq",uid:"42",credential:"twc1_old"}
  await saveMusicAccount("qq",current,{file:accountsFile})
  const signal = new AbortController()
  const login = {platform:"qq",alias:"lotus-music-qq",key:"synthetic",owner:42}
  const service = new MusicService({accountsFile,tuneweave:{request:async()=>{
    if (!signal.signal.aborted) signal.abort()
    return {state:"confirmed",profile:{authenticated:true,platform:"netease",account:"another-alias",user_id:"43"}}
  }}})
  await expect(service.waitLogin(login,{signal:signal.signal})).rejects.toThrow("取消")
  await expect(service.waitLogin(login)).rejects.toThrow("账号不匹配")
  expect((await readMusicAccounts(accountsFile)).qq).toEqual(current)
})

test("扫码确认的登录状态、账号标识和凭据平台须可核实", async () => {
  const accountsFile = join(await directory(), "music.yaml")
  const current = { alias: "lotus-music-qq", uid: "42", credential: "twc1_old" }
  const login = { platform: "qq", alias: current.alias, key: "synthetic", owner: 42 }
  const profile = { platform: login.platform, account: login.alias, authenticated: true, user_id: "43" }
  let confirmation = { ...profile, authenticated: "false" }
  let recovered = { ...profile, user_id: {} }
  let credential = { platform: "qq", value: "twc1_new" }
  const service = new MusicService({ accountsFile, tuneweave: { request: async (route, options) => {
    if (route === "/v1/auth/qr/synthetic") return { state: "confirmed", profile: confirmation, caller_credential: credential }
    expect(route).toBe("/v1/account?platform=qq&account=lotus-music-qq")
    expect(options.redirect).toBe("error")
    return recovered
  } } })
  await saveMusicAccount("qq", current, { file: accountsFile })
  await expect(service.waitLogin(login)).rejects.toThrow("身份未核验")
  expect((await readMusicAccounts(accountsFile)).qq).toEqual(current)

  confirmation = profile
  credential = { platform: "netease", value: "twc1_wrong_platform" }
  await expect(service.waitLogin(login)).rejects.toThrow("登录凭据平台不匹配")
  expect((await readMusicAccounts(accountsFile)).qq).toEqual(current)

  confirmation = { ...profile, user_id: undefined }
  recovered = profile
  credential = { platform: "qq", value: "twc1_new" }
  await expect(service.waitLogin(login)).resolves.toEqual({ ok: true })
  expect((await readMusicAccounts(accountsFile)).qq).toMatchObject({ uid: "43", credential: "twc1_new" })
})

test("点歌扫码保留网易云五分钟等候和其他平台三分钟等候", async () => {
  const now = spyOn(Date, "now")
  const calls = []
  const service = new MusicService({ tuneweave:{ request:async path => {
    calls.push(path)
    return {state:"expired"}
  } } })
  try {
    now.mockReturnValueOnce(0).mockReturnValue(200000)
    await expect(service.waitLogin({platform:"netease",key:"netease"})).rejects.toThrow("二维码已过期")
    now.mockReturnValueOnce(0).mockReturnValue(200000)
    await expect(service.waitLogin({platform:"qq",key:"qq"})).rejects.toThrow("扫码登录超时")
    now.mockReturnValueOnce(0).mockReturnValue(300000)
    await expect(service.waitLogin({platform:"netease",key:"late"})).rejects.toThrow("扫码登录超时")
    expect(calls).toEqual(["/v1/auth/qr/netease"])
  } finally { now.mockRestore() }
})

test("TuneWeave 的 B 站和网易云就绪检查使用各自已注册的能力",async()=>{
  const endpoints = []
  let version = "1.0.0-beta.3"
  const api = new TuneWeaveService({
    config: {api_url:"http://localhost/fixture"},
    fetch:async input=>{
      const url=new URL(input)
      endpoints.push(url.pathname+url.search)
      const data=url.pathname.endsWith("healthz") ? {version} : [
        {registered:true,platform:"bilibili",capabilities:["qr_login","account_profile"]},
        {registered:true,platform:"netease",capabilities:["platform_api","qr_login","account_profile","caller_managed_credentials"]},
      ]
      return Response.json({ok:true,data})
    },
  })
  expect((await api.status()).ok).toBe(false)
  expect((await api.status("netease")).ok).toBe(true)
  expect((await api.initialize({platform:"netease"})).already).toBe(true)
  version = "1.0.0-beta.2"
  expect((await api.status("netease")).requiresUpdate).toBe(true)
  await expect(api.requireReady("netease")).rejects.toThrow("低于要求")
  expect(endpoints).toContain("/fixture/v1/capabilities?platform=bilibili")
  expect(endpoints).toContain("/fixture/v1/capabilities?platform=netease")
})

test("点歌和完整播放仅续期同平台的公共账号，续期成功后只重试一次", async () => {
  const file = join(await directory(), "music.yaml")
  const foreignCredential = "twc1_unrelated-qq"
  await saveMusicAccount("qq", { alias: "lotus-qq", uid: "23", owner: 71, credential: foreignCredential }, { file })
  for (const platform of ["kugou", "soda", "migu", "kuwo"]) {
    const initial = { alias: "lotus-" + platform, uid: "42", owner: 99, credential: "twc1_initial" }
    const refreshedCredential = "twc1_refreshed"
    const song = { ...track, ref: platform + ":1042", platform }
    for (const action of ["search", "resolve"]) {
      const calls = []
      await saveMusicAccount(platform, initial, { file })
      const service = new MusicService({ accountsFile: file, tuneweave: { config: { api_url: "http://localhost:7832" },
        request: async (route, options) => {
          calls.push(route)
          const url = new URL(route, "http://localhost:7832")
          if (url.pathname === "/v1/auth/session/refresh") {
            expect(options.body).toEqual({ platform, account: initial.alias, credential_mode: "both" })
            expect(options.credentials).toEqual([initial.credential])
            return { data: { platform, account: initial.alias, authenticated: true, user_id: initial.uid,
              caller_credential: { platform, value: refreshedCredential } }, accountSelected: true }
          }
          expect(url.searchParams.has("account")).toBe(false)
          if (action === "resolve") {
            expect(url.searchParams.get("fallback")).toBe("false")
            expect(url.searchParams.get("unblock")).toBe("false")
          }
          if (platform === "kuwo" && action === "search") {
            expect(options.credentials).toEqual([])
          } else if (calls.length === 1) {
            expect(options.credentials).toEqual([initial.credential])
            throw Object.assign(new Error("合成过期"), { code: "authentication_required", platform })
          } else {
            expect(options.credentials).toEqual([refreshedCredential])
          }
          if (action === "search") return { data: [{ type: "track", data: song }], accountSelected: platform !== "kuwo" }
          return { url: "https://example.test/sample", resolved_platform: platform, origin_track: song.ref, resolved_track: song.ref }
        },
      } })
      const initialOperation = platform === "kuwo" && action === "search"
      if (action === "search") expect((await service.search(platform, "示例")).accountStatus).toBe(initialOperation ? "unconfigured" : "selected")
      else expect((await service.resolve(song, { exact: true })).resolved_track).toBe(song.ref)
      expect(calls.length).toBe(initialOperation ? 1 : 3)
      const saved = await readMusicAccounts(file)
      expect(saved[platform]).toEqual({ ...initial, credential: initialOperation ? initial.credential : refreshedCredential })
      expect(saved.qq.credential).toBe(foreignCredential)
    }
  }
})

test("音乐续期阻断跨平台错误、异 UID、并发换绑和重试后仍到期", async () => {
  const file = join(await directory(), "music.yaml")
  const platform = "soda", original = { alias: "lotus-soda", uid: "42", owner: 99, credential: "twc1_initial" }
  const changed = { alias: "lotus-soda-other", uid: "83", owner: 91, credential: "twc1_unrelated" }
  const refreshError = provider => Object.assign(new Error("合成过期"), { code: "authentication_required", platform: provider })
  for (const failure of ["other platform", "other uid", "race", "still expired"]) {
    let searches = 0, renewals = 0
    await saveMusicAccount(platform, original, { file })
    const service = new MusicService({ accountsFile: file, tuneweave: { config: { api_url: "http://localhost:7832" },
      request: async route => {
        if (route.startsWith("/v1/search?")) {
          searches++
          throw refreshError(failure === "other platform" ? "kugou" : platform)
        }
        renewals++
        if (failure === "race") await saveMusicAccount(platform, changed, { file })
        return { data: { platform, account: original.alias, authenticated: true,
          user_id: failure === "other uid" ? "73" : original.uid, caller_credential: { platform, value: "twc1_next" } }, accountSelected: true }
      },
    } })
    await expect(service.search(platform, "示例")).rejects.toThrow()
    expect(searches).toBe(failure === "still expired" ? 2 : 1)
    expect(renewals).toBe(failure === "other platform" ? 0 : 1)
    expect((await readMusicAccounts(file))[platform]).toEqual(failure === "race" ? changed :
      { ...original, credential: failure === "still expired" ? "twc1_next" : original.credential })
  }
})

test("旧公共 QQ 登录与仅有服务端别名的网易云可续原账号，续期不授予私人权限", async () => {
  const accountsFile = join(await directory(), "music.yaml")
  for (const [platform, credential] of [["qq", "twc1_legacy"], ["netease", ""]]) {
    const alias = "old-" + platform, uid = "42"
    const signal = new AbortController().signal
    const song = { ...track, ref: platform + ":1042", platform }
    for (const action of ["search", "resolve"]) {
      const calls = []
      const newCredential = credential && "twc1_renewed"
      let renewed = false
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const url = new URL(request.url)
        const incoming = request.headers.get("x-tuneweave-credential")
        calls.push(url.pathname)
        const meta = { platform, account: alias }
        if (url.pathname === "/v1/auth/session/refresh") {
          expect(incoming).toBe(credential || null)
          expect(await request.json()).toEqual({ platform, account: alias, credential_mode: credential ? "both" : "server" })
          renewed = true
          return Response.json({ ok: true, meta, data: { ...meta, authenticated: true, user_id: uid,
            ...(credential && { caller_credential: { platform, value: newCredential } }) } })
        }
        if (!renewed) {
          expect(incoming).toBe(credential || null)
          return Response.json({ ok: false, error: { platform, code: "authentication_required" } }, { status: 401 })
        }
        expect(incoming).toBe(newCredential || null)
        const data = url.pathname === "/v1/search" ? [{ type: "track", data: song }]
          : { url: "https://audio.example.test/test", resolved_platform: platform, origin_track: song.ref, resolved_track: song.ref }
        return Response.json({ ok: true, meta, data }, { headers: {
          ...(newCredential && { "X-TuneWeave-Updated-Credential": `${platform}=${newCredential}` }),
        } })
      } })
      try {
        await saveMusicAccount(platform, { alias, uid, credential }, { file: accountsFile })
        const service = new MusicService({ accountsFile, tuneweaveConfig: { api_url: server.url.origin } })
        if (action === "search") {
          expect(await service.search(platform, "隔离样本", 1, { signal })).toEqual({ tracks: [song], accountStatus: "selected" })
        } else expect((await service.resolve(song, { exact: true, signal })).resolved_track).toBe(song.ref)
        expect(calls).toHaveLength(3)
        expect(calls[1]).toBe("/v1/auth/session/refresh")
        expect((await readMusicAccounts(accountsFile))[platform]).toEqual({ alias, uid, credential: newCredential })
        if (platform === "qq") {
          await expect(readQqCollection(service, "favorites", 99, 1, signal)).rejects.toMatchObject({ code: "authentication_required" })
          expect(await service.reuseMusicLogin(platform, 99, signal, true)).toBe(false)
          expect(calls).toHaveLength(3)
        }
      } finally {
        await server.stop(true)
      }
    }
  }
})

test("酷狗、汽水、酷我、咪咕只有绑定主人可在受信私聊显式刷新", async () => {
  const file = join(await directory(), "music.yaml")
  const requested = []
  const api = new MusicService({ accountsFile: file, tuneweave: { config: { api_url: "http://localhost:7832" },
    request: async (route, { body }) => {
      expect(route).toBe("/v1/auth/session/refresh")
      requested.push(body.platform)
      return { data: { platform: body.platform, account: body.account, authenticated: true, user_id: "42",
        caller_credential: { platform: body.platform, value: "twc1_next" }, extensions: { refreshed: body.platform !== "soda" } },
        accountSelected: true }
    },
  } })
  const commands = createMusicCommands({ openMusic: async () => ({ api, defaultPlatform: "netease", timeoutMs: 120_000 }) })
  const context = { message_type: "private", self_id: 99, user_id: 42, canManagePackages: true, privateCredentialSignal: new AbortController().signal }
  try {
    for (const [name, platform] of [["酷狗", "kugou"], ["汽水", "soda"], ["酷我", "kuwo"], ["咪咕", "migu"]]) {
      await saveMusicAccount(platform, { alias: "lotus-" + platform, uid: "42", owner: 42, credential: "twc1_initial" }, { file })
      const message = `#刷新${name}音乐登录`
      const count = requested.length
      expect(await commands.fallback(message, { ...context, message_type: "group" })).toContain("好友私聊")
      expect(await commands.fallback(message, { ...context, user_id: 41 })).toContain("绑定账号的主人")
      expect(requested.length).toBe(count)
      expect(await commands.fallback(message, context)).toBe(name + (platform === "soda" ? "登录仍有效。" : "登录已续期。"))
      expect(requested.at(-1)).toBe(platform)
    }
  } finally { await commands.dispose() }
})
