import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import YAML from "yaml"
import { NeteasePartnerAccounts } from "../services/music/partner-account.ts"
import { NeteasePartnerTask } from "../services/music/partner-task.ts"
import { PartnerReviewService } from "../services/music/partner-review.ts"
import { partnerLogNodes, readPartnerLog } from "../services/music/partner-log.ts"
import { createPartnerSchedule, partnerCron } from "../services/music/partner-schedule.ts"

test("合伙人先核验旧账号，沿用任务顺序、账号偏好和未确认评分记录", async () => {
  const dir = await mkdtemp(join(tmpdir(),"lotus-partner-task-"))
  const stateFile = join(dir,"state.yaml"), accountsFile = join(dir,"accounts.yaml")
  const account = { uid:"1042", nickname:"合成账号", cookie:"fixture-source-cookie", extraCount:1, comment:false }
  await writeFile(accountsFile,YAML.stringify({ accounts:[account] }))
  await writeFile(stateFile,"last_run_date: 2026-11-19\nold_field: keep\n")
  const calls = [], ratings = []
  let daily = 0, identity = "1042"
  const server = Bun.serve({ hostname:"127.0.0.1", port:0, async fetch(request) {
    const url = new URL(request.url)
    expect(request.headers.has("cookie")).toBe(false)
    expect(request.headers.has("x-tuneweave-credential")).toBe(false)
    const ok = data => Response.json({ ok:true, data })
    if (url.pathname === "/healthz") return ok({ version:"1.0.0-beta.3" })
    if (url.pathname === "/v1/capabilities") return ok([{ platform:"netease", registered:true,
      capabilities:["platform_api","qr_login","account_profile","caller_managed_credentials"] }])
    if (url.pathname === "/v1/account") {
      expect(url.searchParams.get("account")).toBe("default")
      return ok({ authenticated:true, user_id:identity })
    }
    expect(url.pathname).toBe("/v1/extensions/netease/api")
    const raw = await request.text()
    expect(raw).not.toContain("fixture-source-cookie")
    const { uri, data, account:alias } = JSON.parse(raw)
    expect(alias).toBe("default")
    calls.push(uri.split("/").at(-1))
    if (uri.endsWith("/daily/task/get")) {
      daily++
      return ok({ code:200, data:{ id:42, works:[
        { work:{id:1,name:"此前完成"}, completed:true },
        { work:{id:2,name:"首次提交",supportExtraEvaTypes:["作词", {dimensionId:7}]}, dimensions:["忽略旧维度"] },
        { work:{id:3,name:"回执中断"} },
        { work:{id:4,name:"额度轮询"} },
      ] } })
    }
    if (uri.endsWith("/extra/wait/evaluate/work/list")) return ok({code:200,data:[{id:5,name:"额外曲目"},{id:6,name:"超额曲目"}]})
    const state = YAML.parse(await readFile(stateFile,"utf8"))
    expect(state.evaluation_receipts).toContainEqual(["1042:"+data.workId,"pending"])
    ratings.push(data)
    if (data.workId === 3) return Response.json({ ok:false,error:{code:"upstream_error",message:"cookie=should-never-log"} }, {status:502})
    if (data.workId === 4 && daily === 1) return Response.json({ ok:false,error:{code:"upstream_error",details:{upstream_code:405}} }, {status:502})
    return ok({ code:200 })
  } })
  try {
    const config = { delay_ms_min:0, delay_ms_max:0, comments:["本测试不能发布评论"] }
    const task = () => new NeteasePartnerTask({
      tuneweaveConfig:{api_url:`http://127.0.0.1:${server.port}`},
      accounts:new NeteasePartnerAccounts(accountsFile), stateFile, logDir:dir,
      now:()=>new Date(2026,10,20,12), scorer:()=>4,
    })
    const first = await task().execute(config)
    expect(daily).toBe(2)
    expect(ratings.map(rating=>rating.workId)).toEqual([2,3,4,4,5])
    expect(ratings.every(rating=>!rating.comment && rating.syncComment==="false" && rating.taskId===42)).toBe(true)
    expect(JSON.parse(ratings[0].extraScore)).toEqual({"作词":4,"7":4})
    expect(ratings.at(-1).extraResource).toBe("true")
    expect(first.accounts[0]).toMatchObject({success:4,skip:1,fail:16,attempts:2})
    expect(first.accounts[0].evaluations.find(item=>item.workId==="3").status).toBe("unknown")
    expect(partnerLogNodes(first).some(item=>item.text.includes("结果未确认"))).toBe(true)
    const persisted = YAML.parse(await readFile(accountsFile,"utf8")).accounts[0]
    expect(persisted).toMatchObject({uid:"1042",tuneweave_account:"default",extraCount:1,comment:false})
    expect(persisted.cookie).toBeUndefined()
    expect(YAML.parse(await readFile(stateFile,"utf8"))).toMatchObject({last_run_date:"2026-11-20",old_field:"keep"})
    expect((await stat(join(dir,"nep-latest.json"))).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(await readPartnerLog(dir))).not.toContain("should-never-log")

    expect(await task().execute(config,"自动任务",{once:true})).toEqual({skipped:true,reason:"already_run_today"})
    expect(daily).toBe(2)
    await task().execute(config)
    expect(daily).toBe(4)
    expect(ratings).toHaveLength(5)
    identity = "other-account"
    await task().execute(config)
    expect(daily).toBe(4)
    expect(ratings).toHaveLength(5)
    expect(calls.filter(route=>route==="evaluate")).toHaveLength(5)
  } finally { server.stop(true); await rm(dir,{recursive:true,force:true}) }
})

test("空合伙人档案保存说明，未连接平台", async () => {
  const dir = await mkdtemp(join(tmpdir(),"lotus-partner-empty-"))
  try {
    const task = new NeteasePartnerTask({
      accounts:new NeteasePartnerAccounts(join(dir,"missing.yaml")), stateFile:join(dir,"state.yaml"), logDir:dir,
      tuneweave:{ request() { throw new Error("不应联网") }, requireReady() { throw new Error("不应联网") } },
    })
    const report = await task.execute()
    expect(report.accounts[0]).toMatchObject({nickname:"未配置账号",success:0,fail:0})
    expect(await readPartnerLog(dir)).toEqual(report)
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test("自动合伙人沿用原日记录，新状态优先，旧日期冲突时不执行", async () => {
  const dir = await mkdtemp(join(tmpdir(),"lotus-partner-old-day-"))
  const stateFile = join(dir,"state.yaml"), old = join(dir,"old.yaml"), other = join(dir,"another-old.yaml")
  const source = "last_run_date: '2026-11-20'\nlast_run_time: '2026-11-20T08:10:10+08:00'\n"
  try {
    await writeFile(old,source)
    const task = new NeteasePartnerTask({
      stateFile, legacyStateFiles:[old,other], logDir:dir, now:()=>new Date(2026,10,20,12),
      accounts:{ loadAccounts() { throw new Error("已有日记录时无需读取") } },
    })
    expect(await task.hasRunToday()).toBe(true)
    expect(await task.execute({}, "自动任务", {once:true})).toEqual({skipped:true,reason:"already_run_today"})
    expect(await Bun.file(stateFile).exists()).toBe(false)
    await writeFile(other,"last_run_date: '2026-11-19'\n")
    await expect(task.hasRunToday()).rejects.toThrow("两处旧合伙人任务记录不一致")
    await writeFile(stateFile,"{}\n")
    expect(await task.hasRunToday()).toBe(false)
    expect(await readFile(old,"utf8")).toBe(source)
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test("定时和启动补跑只在宿主激活后执行，关闭、同日已运行和断线时跳过", async () => {
  let ready, cronRun, dayRecorded = false
  const delayed = Promise.withResolvers(), waitStarted = Promise.withResolvers(), done = Promise.withResolvers()
  const now = () => new Date(2026,10,20,2)
  const config = { netease_partner:{enable:true, auto_catch_up:true} }
  const calls = [], handoff = new AbortController()
  const runtime = {
    disconnect:handoff.signal,
    whenReady(action) { ready = action; return () => calls.push("unready") },
    registerTask(cron, action) {
      expect(cron).toBe("0 5 0 * * *")
      cronRun = action
      return () => calls.push("unregister")
    },
    async notifyMasters(reply) { calls.push(reply); done.resolve() },
  }
  const dispose = await createPartnerSchedule({mediaRuntime:runtime}, {
    load:async()=>config, now,
    hasRunToday:async()=>dayRecorded,
    wait:async(ms, signal)=>{expect(ms).toBe(60000);expect(signal.aborted).toBe(false);waitStarted.resolve();await delayed.promise},
    ensureReady:async()=>calls.push("status"),
    async execute(_config,trigger,options) { expect(options.once).toBe(true); calls.push(trigger); dayRecorded=true; return {accounts:[]} },
    async render() { return {text:"通知给主人"} },
  })
  expect(partnerCron("5 0 * * ?")).toBe("0 5 0 * * *")
  expect(partnerCron("")).toBe("0 5 0 * * *")
  expect(partnerCron("0 5 0 * * ? *")).toBe("0 5 0 * * *")
  expect(() => partnerCron("0 5 0 * * ? 2026")).toThrow()
  await cronRun()
  expect(calls).toEqual([])
  ready()
  await waitStarted.promise
  expect(calls).toEqual([])
  delayed.resolve()
  await done.promise
  await cronRun()
  expect(calls).toEqual(["status","启动补跑","通知给主人"])
  dayRecorded = false
  config.netease_partner.enable = false
  await cronRun()
  expect(calls).toEqual(["status","启动补跑","通知给主人"])
  handoff.abort()
  config.netease_partner.enable = true
  await cronRun()
  await dispose()
  expect(calls).toEqual(["status","启动补跑","通知给主人","unready","unregister"])
})

test("正常定时不补跑，原设置关闭时不生成主人通知", async () => {
  let ready, cronRun
  const calls = []
  const dispose = await createPartnerSchedule({mediaRuntime:{
    whenReady(action) { ready=action; return ()=>{} },
    registerTask(_cron, action) { cronRun=action; return ()=>{} },
    notifyMasters() { throw new Error("关闭时不能通知") },
  }}, {
    load:async()=>({netease_partner:{enable:true,auto_catch_up:false,notify_master:false}}),
    hasRunToday:async()=>false,
    wait(){throw new Error("关闭补跑时无需等待")},
    execute:async(_config,trigger)=>{calls.push(trigger);return {accounts:[]}},
    render(){throw new Error("关闭通知时无需渲染")},
  })
  ready()
  await cronRun()
  expect(calls).toEqual(["自动任务"])
  await dispose()
})

test("合伙人乐评只接受本次联网证据中的来源", async () => {
  let source = "https://music.example/track", searched = source
  const comment = "围绕离别与重逢的歌词来写，这个故事在第二段留下了更多余地。"
  const service = new PartnerReviewService({ fetch:async (_url, init) => {
    expect(init.redirect).toBe("error")
    expect(JSON.parse(init.body).store).toBe(false)
    return Response.json({status:"completed",output:[
      {type:"web_search_call",status:"completed",action:{sources:[{url:searched}]}},
      {type:"message",content:[{type:"output_text",text:JSON.stringify({comment,sources:[source]})}]},
    ]})
  } })
  const config = {mode:"responses",model:"合成模型",api_key:"fixture-api-key",api_url:"http://127.0.0.1:1"}
  expect(await service.generate({title:"合成歌曲"},config)).toEqual({comment,sources:[source]})
  searched = "https://music.example/elsewhere"
  await expect(service.generate({title:"合成歌曲"}, config)).rejects.toThrow("未出现在实际联网结果")
})

test("Codex 乐评沿用只读模式并要求可见的联网执行证据", async () => {
  let searched = true
  const review = {comment:"把未寄出的信放在结尾，让词里那个迟迟没有说开的人有了落点。",sources:["https://music.example/song"]}
  const service = new PartnerReviewService({ spawnProcess(command, args, options) {
    expect(command).toBe("mock-codex")
    expect(args).toContain("read-only")
    expect(args).toContain("features.shell_tool=false")
    expect(options.shell).toBe(false)
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin.resume()
    child.stdin.on("end", async () => {
      await writeFile(args[args.indexOf("--output-last-message")+1],JSON.stringify(review))
      if (searched) child.stdout.write('{"type":"item.completed","item":{"type":"web_search"}}\n')
      child.emit("close",0)
    })
    return child
  } })
  const config = {mode:"codex",codex_command:"mock-codex"}
  expect(await service.generate({title:"合成歌曲"},config)).toEqual(review)
  searched = false
  await expect(service.generate({title:"合成歌曲"},config)).rejects.toThrow("未执行联网搜索")
})
