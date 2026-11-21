import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TuneWeaveService } from "../services/tuneweave/service.ts"
import { resumeTuneWeaveOnStart } from "../services/tuneweave/startup.ts"

test("TuneWeave 启动恢复只在宿主接管后启动，并随断开取消", async () => {
  let enter
  const inFlight = Promise.withResolvers()
  const disconnect = new AbortController()
  const calls = []
  const runtime = { disconnect:disconnect.signal, whenReady(action) { enter=action; return () => calls.push("取消登记") } }
  const hooks = {
    async load() { calls.push("读配置"); return {} },
    async resume(_config,signal) {
      calls.push("恢复")
      inFlight.resolve()
      await new Promise(resolve=>signal.addEventListener("abort",resolve,{once:true}))
      calls.push("停止")
    },
  }
  expect(resumeTuneWeaveOnStart({},hooks)).toBeUndefined()
  const dispose = resumeTuneWeaveOnStart({mediaRuntime:runtime},hooks)
  expect(calls).toEqual([])
  enter()
  await inFlight.promise
  expect(calls).toEqual(["读配置","恢复"])
  disconnect.abort()
  await dispose()
  expect(calls).toEqual(["读配置","恢复","取消登记","停止"])
})

test("自动恢复跳过自建端点和无原记录安装，且不请求错位的本机记录", async () => {
  const dir = await mkdtemp(join(tmpdir(),"lotus-tuneweave-resume-"))
  const local = "http://127.0.0.1:17832"
  const calls = []
  const service = api_url => new TuneWeaveService({root:dir, config:{api_url}, async fetch(url,options) {
    calls.push(new URL(url).pathname)
    expect(options.redirect).toBe("error")
    if (url.endsWith("/healthz")) return Response.json({ok:true,data:{version:"1.0.0-beta.3"}})
    return Response.json({ok:true,data:[{platform:"bilibili",registered:true,
      capabilities:["qr_login","account_profile","search_videos","video_detail","video_parts","video_playback_manifest"]}]})
  }, spawn() { throw new Error("已有监听，无需再起子进程") }})
  try {
    expect(await service(local).resume()).toEqual({skipped:true})
    await mkdir(join(dir,"bin"))
    await writeFile(join(dir,"bin/tuneweave"),"合成文件")
    await writeFile(join(dir,"process.json"),JSON.stringify({pid:2147483647,api_url:local}))
    expect(await service("https://external.example:17832").resume()).toEqual({skipped:true})
    await expect(service("http://127.0.0.1:17833").resume()).rejects.toThrow("进程记录与当前实例不一致")
    expect(calls).toEqual([])
    expect((await service(local).resume()).ok).toBe(true)
    expect(calls).toEqual(["/healthz","/v1/capabilities"])
  } finally { await rm(dir,{recursive:true,force:true}) }
})
