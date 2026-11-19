import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import YAML from "yaml"
import { MusicService, musicSessionKey, musicShare } from "../services/music/service.js"
import { readMusicAccounts, saveMusicAccount } from "../services/music/accounts.js"

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
    if (request.pathname === "/v1/search") return [{type:"artist",data:{}},{type:"track",data:track}]
    return {url:"https://audio.example.test/test.mp3",resolved_platform:"qq",trial:false}
  } } })
  expect(await service.search("netease", "  合成曲目  ", 2)).toEqual([track])
  const stream = await service.resolve(track)
  expect(Object.fromEntries(searches[0].searchParams)).toEqual({
    platform:"netease",type:"track",q:"合成曲目",limit:"10",offset:"10",account:"lotus-nep-fixture",
  })
  expect(searches[1].searchParams.get("fallback_platforms")).toBe("qq,kugou,kuwo,migu,soda")
  expect(musicShare(track,stream)?.data).toMatchObject({type:"163",url:"https://music.163.com/#/song?id=1042",title:"合成曲目"})
  expect(musicShare(track,{...stream,headers:{Cookie:"fixture-private"}})).toBeNull()
  expect(musicShare(track,{...stream,url:"/v1/track/private"})).toBeNull()
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

test("TuneWeave 的 B 站和网易云就绪检查使用各自已注册的能力",async()=>{
  const { TuneWeaveService } = await import("../services/tuneweave/service.js")
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
