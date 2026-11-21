import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import YAML from "yaml"
import { MusicService, musicSessionKey, musicShare } from "../services/music/service.ts"
import { readMusicAccounts, saveMusicAccount } from "../services/music/accounts.ts"
import { readPartnerLog, partnerLogNodes } from "../services/music/partner-log.ts"
import { TuneWeaveService } from "../services/tuneweave/service.js"

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

test("点歌会话按机器人、群或私聊、发起人隔离", () => {
  const subject = {self_id:99,user_id:42,group_id:77}
  expect(musicSessionKey(subject)).toBe("99:77:42")
  expect(new Set([
    musicSessionKey(subject),
    musicSessionKey({...subject,self_id:98}),
    musicSessionKey({...subject,group_id:undefined}),
    musicSessionKey({...subject,user_id:43}),
  ]).size).toBe(4)
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
  expect((await readMusicAccounts(accountsFile)).netease).toEqual({alias:"lotus-nep-42",uid:"1042",nickname:"新昵称",credential:"twc1_test_account"})
  const partner = YAML.parse(await readFile(partnerAccountsFile,"utf8")).accounts
  expect(partner).toHaveLength(1)
  expect(partner[0]).toMatchObject({uid:"1042",qq:"42",extraCount:6,comment:false,tuneweave_account:"lotus-nep-42"})
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
