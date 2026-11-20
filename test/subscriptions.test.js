import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import YAML from "yaml"
import { lockFile } from "../../../lib/file-lock.ts"
import { changeTypes, createSubscriptionConfig, settingsFor } from "../services/subscriptions/config.js"
import { createBiliProvider, biliTypes, normalizeBiliDynamic } from "../services/subscriptions/bilibili/index.js"
import { articleContent } from "../services/subscriptions/bilibili/article.js"
import { createSubscriptionDelivery, receiptKey, useDynamicForward } from "../services/subscriptions/delivery.js"
import { createSubscriptionModule } from "../services/subscriptions/module.js"
import { makeDynamicMessages } from "../services/subscriptions/render.js"
import { renderSubscriptionHelp } from "../services/subscriptions/help.js"

const temp=[]
async function directory() {
  const root=await mkdtemp(join(tmpdir(),"lotus-yuki-unit-"))
  temp.push(root)
  return root
}
afterEach(async()=>Promise.all(temp.splice(0).map(root=>rm(root,{force:true,recursive:true}))))

const seen=1700000000
const uid="401742377"
const draw="DYNAMIC_TYPE_DRAW"
const article="DYNAMIC_TYPE_ARTICLE"
const route={kind:"group",chat:"77",bot:"99",uid,name:"原神",types:[]}

function raw(type=draw,fields={}) {
  return { id_str:"12234455",type,
    modules:{module_author:{mid:uid,pub_ts:seen,name:"试验发布者"},module_dynamic:fields} }
}

test("B站动态解析适配 Yuki 的 Opus 图文、直播、原转发与来源域",()=>{
  const original=raw(draw,{major:{opus:{title:"标题",summary:{rich_text_nodes:[{text:"正文"},{"text":"#话题#"}]},pics:[
    {url:"//i0.hdslb.com/test.webp"},{url:"https://wrong.test/a.png"},
  ]}}})
  const forwarded=normalizeBiliDynamic({...raw("DYNAMIC_TYPE_FORWARD",{desc:{text:"转发文字"}}),id_str:"12234456",orig:original},uid)
  expect(forwarded).toMatchObject({id:"12234456",content:"转发文字",forwarded:{content:"正文#话题#",images:["https://i0.hdslb.com/test.webp"]}})
  const live=normalizeBiliDynamic(raw("DYNAMIC_TYPE_LIVE_RCMD",{major:{live_rcmd:{content:JSON.stringify({live_play_info:{
    title:"直播",link:"//live.bilibili.com/12",cover:"//i0.hdslb.com/live.jpg",
  }})}}}),uid)
  expect(live).toMatchObject({title:"直播",url:"https://live.bilibili.com/12",cover:"https://i0.hdslb.com/live.jpg"})
  expect(normalizeBiliDynamic(original,"123")).toBeUndefined()
})

test("B站视频和直播的文字推送保留原动态类别字段和明确的链接",async()=>{
  const provider=createBiliProvider()
  const settings=settingsFor({pushMsgMode:0,mergeTextPic:0})
  const videoRaw=raw("DYNAMIC_TYPE_AV",{major:{archive:{title:"视频标题",desc:"视频简介",jump_url:"//www.bilibili.com/video/BV1234567890",
    cover:"//i0.hdslb.com/video.jpg",stat:{play:"1.2万",danmaku:"0"},
  }}})
  videoRaw.modules.module_stat={like:{count:23},comment:{count:0},forward:{count:"无数据"}}
  const [video,attachment]=await makeDynamicMessages(provider,normalizeBiliDynamic(videoRaw,uid),settings)
  expect(video.type).toBe("text")
  expect(video.text).toContain("0弹幕 • 1.2万播放 • 23点赞 • 0评论")
  expect(video.text).not.toContain("转发")
  expect(video.text).toEndWith("https://www.bilibili.com/video/BV1234567890")
  expect(attachment).toEqual({type:"image",file:"https://i0.hdslb.com/video.jpg"})

  const liveRaw=({link,live_start_time})=>raw("DYNAMIC_TYPE_LIVE_RCMD",{major:{live_rcmd:{content:JSON.stringify({live_play_info:{
    title:"直播标题",link,parent_area_name:"单机游戏",area_name:"原神",live_start_time,watched_show:{num:0},
  }})}}})
  const [live]=await makeDynamicMessages(provider,normalizeBiliDynamic(liveRaw({
    link:"//live.bilibili.com/12",live_start_time:seen-60,
  }),uid),settings)
  expect(live.text).toContain("开播：2023/11/15 06:12:20")
  expect(live.text).toContain("分区：单机游戏 (原神)\n0人看过")
  expect(live.text).toEndWith("直播链接：https://live.bilibili.com/12")
  const [fallback]=await makeDynamicMessages(provider,normalizeBiliDynamic(liveRaw({
    link:"https://other.invalid/12",live_start_time:true,
  }),uid),settings)
  expect(fallback.text).not.toContain("开播：")
  expect(fallback.text).not.toContain("直播链接：")
  expect(fallback.text).toEndWith("https://m.bilibili.com/dynamic/12234455")
})

test("B站转发先给转发帖链接，再给原帖类别、正文和原帖链接",async()=>{
  const provider=createBiliProvider()
  const settings=settingsFor({pushMsgMode:0})
  const original=raw("DYNAMIC_TYPE_WORD",{desc:{text:"原帖正文"}})
  const repost={...raw("DYNAMIC_TYPE_FORWARD",{desc:{text:"转发正文"}}),id_str:"12234456",orig:original}
  original.modules.module_stat={like:{count:"2.5万"},forward:{count:3}}
  repost.modules.module_stat={like:{count:12000},comment:{count:0},forward:{count:-1}}
  const [message]=await makeDynamicMessages(provider,normalizeBiliDynamic(repost,uid),settings)
  expect(message.text).toContain("转发正文\n1.2万点赞 • 0评论\n转发链接：https://m.bilibili.com/dynamic/12234456\n原帖 · 图文 · 试验发布者")
  expect(message.text).toEndWith("原帖正文\n2.5万点赞 • 3转发\n原帖链接：https://m.bilibili.com/dynamic/12234455")
  const [unavailable]=await makeDynamicMessages(provider,normalizeBiliDynamic({...repost,orig:null},uid),settings)
  expect(unavailable.text).toEndWith("转发链接：https://m.bilibili.com/dynamic/12234456")
  expect(unavailable.text).not.toContain("原帖链接")
})

test("B站图文和专栏文字推送只显示合法互动计数",async()=>{
  const provider=createBiliProvider()
  for (const type of [draw,article]) {
    const item=raw(type,{major:{opus:{summary:{text:"公开正文"}}}})
    item.modules.module_stat={like:{count:"未记录"},comment:{count:0},forward:{count:123456}}
    const [message]=await makeDynamicMessages(provider,normalizeBiliDynamic(item,uid),settingsFor({pushMsgMode:0}))
    expect(message.text).toContain("公开正文\n0评论 • 12.3万转发\n链接：")
    expect(message.text).not.toContain("点赞")
  }
})

test("文字正文按旧行数和字数裁剪，跨行和原帖各自保留完整字符",async()=>{
  const provider=createBiliProvider()
  const original=raw("DYNAMIC_TYPE_WORD",{desc:{text:"原句\r\n字🚀超长\r\n末行"}})
  const repost={...raw("DYNAMIC_TYPE_FORWARD",{desc:{text:"转🚀\n发帖超长\n末行"}}),id_str:"12234456",orig:original}
  const unified=normalizeBiliDynamic(repost,uid)
  const text=async options=>(await makeDynamicMessages(provider,unified,settingsFor({pushMsgMode:0,...options})))[0].text
  const both=await text({pushContentLenLimit:4,pushContentLineLimit:2})
  expect(both).toContain("转🚀\n发帖...\n转发链接：")
  expect(both).toContain("原句\n字🚀...\n原帖链接：")
  expect(both).not.toContain("末行")
  const lines=await text({pushContentLenLimit:100,pushContentLineLimit:1})
  expect(lines).toContain("转🚀\n转发链接：")
  expect(lines).not.toContain("...")
  const suppressed=await text({pushContentLenLimit:0,pushContentLineLimit:1})
  expect(suppressed).not.toContain("转🚀")
  expect(suppressed).toEndWith("原帖链接：https://m.bilibili.com/dynamic/12234455")
})

test("B站匿名查询明确区分 HTTP 拒绝并读取原公开文章内嵌数据",async()=>{
  const requests=[]
  const feed=createBiliProvider({fetch:async (u,options)=>{
    requests.push([u,options])
    return new Response(null,{status:412})
  }})
  await expect(feed.fetchPosts(uid)).rejects.toThrow("HTTP 412")
  expect(requests[0][0].searchParams.get("host_mid")).toBe(uid)
  expect(requests[0][1].credentials).toBe("omit")
  expect(articleContent('"readInfo":{"content":"<p>正文</p><img data-src=\\"//i0.hdslb.com/pic.jpg\\">"},"readViewInfo":{}'))
    .toEqual({content:"正文",images:["//i0.hdslb.com/pic.jpg"]})
  const source=raw(article,{major:{opus:{title:"文章",summary:{text:"字".repeat(480)},jump_url:"https://www.bilibili.com/opus/12234455"}}})
  const articleProvider=createBiliProvider({fetch:async url=>url.hostname==="api.bilibili.com"
    ? Response.json({code:0,data:{items:[source]}})
    : new Response('"module_content":'+JSON.stringify({paragraphs:[
      {para_type:1,text:{nodes:[{word:{words:"完整正文".repeat(200)}}]}},
      {para_type:2,pic:{pics:[{url:"//i0.hdslb.com/new.png"}]}},
    ]})+',"module_type":"MODULE_TYPE_CONTENT"')})
  expect((await articleProvider.fetchPosts(uid))[0]).toMatchObject({content:"完整正文".repeat(200),images:["https://i0.hdslb.com/new.png"]})
})

test("锅巴配置优先、群与私聊分离，旧类型增删安全保留另一个机器人",async()=>{
  const root=await directory()
  const dir=join(root,"yuki-plugin","config","bilibili")
  await mkdir(dir,{recursive:true})
  await writeFile(join(dir,"push.yaml"),YAML.stringify({group:{77:[]}}))
  await writeFile(join(dir,"config.yaml"),"pushStatus: 0\n")
  await writeFile(join(dir,"config.guoba.support.yaml"),"pushStatus: 1\npushTransmit: 0\n")
  await writeFile(join(dir,"push.guoba.support.yaml"),YAML.stringify({group:{77:[
    {bot_id:99,uid,name:"原群",type:[],metadata:"留"},
    {bot_id:98,uid,name:"另一机器人",type:[draw]},
  ]},private:{42:[{bot_id:99,uid,name:"原私聊"}]}}))
  const cfg=createSubscriptionConfig(root,lockFile)
  expect(await cfg.settings("bilibili")).toMatchObject({enable:true,forwards:false})
  expect((await cfg.routes("bilibili")).length).toBe(3)
  expect(changeTypes([], [draw],Object.keys(biliTypes),"remove")).not.toContain(draw)
  await cfg.update("bilibili",route,uid,"remove",[draw],Object.keys(biliTypes),uid)
  let written=YAML.parse(await readFile(join(dir,"push.guoba.support.yaml"),"utf8"))
  expect(written.group[77][0].metadata).toBe("留")
  expect(written.group[77][0].type).not.toContain(draw)
  expect(written.group[77][1].type).toEqual([draw])
  await cfg.update("bilibili",route,uid,"remove",[],Object.keys(biliTypes),uid)
  written=YAML.parse(await readFile(join(dir,"push.guoba.support.yaml"),"utf8"))
  expect(written.group[77]).toEqual([{bot_id:98,uid,name:"另一机器人",type:[draw]}])
  expect(written.private[42][0].uid).toBe(uid)
  expect(YAML.parse(await readFile(join(dir,"push.yaml"),"utf8"))).toEqual({group:{77:[]}})
})

test("只有明确拒绝访问的 B 站资料可按原 UID 暂存订阅",async()=>{
  const signal=new AbortController().signal
  const denied=[
    {status:403,message:"B 站公开接口 HTTP 403"},{status:412,message:"B 站公开接口 HTTP 412"},
    {code:-403,message:"B 站公开接口返回 -403"},{code:-352,message:"B 站公开接口返回 -352"},
  ]
  for (const {status,code,message} of denied) {
    const provider=createBiliProvider({fetch:async()=>status
      ? new Response(null,{status}) : Response.json({code})})
    await expect(provider.profile(uid,{signal})).rejects.toThrow(message)
    expect(await provider.profile(uid,{signal,allowUnverified:true}))
      .toEqual({uid,name:uid,verificationFailure:message})
  }
  const missing=createBiliProvider({fetch:async()=>Response.json({code:-404})})
  expect(await missing.profile(uid,{signal,allowUnverified:true})).toBeUndefined()
  const broken=createBiliProvider({fetch:async()=>new Response(null,{status:503})})
  await expect(broken.profile(uid,{signal,allowUnverified:true})).rejects.toThrow("HTTP 503")
})

test("聊天指令修改旧订阅文档时保留注释、文件权限和相邻路由",async()=>{
  const root=await directory()
  const dir=join(root,"yuki-plugin","config","bilibili")
  await mkdir(dir,{recursive:true})
  const override=join(dir,"push.guoba.support.yaml")
  const original=`# 文件说明
group:
  77: # 目标群
    - bot_id: 99
      uid: '401742377'
      name: '原神' # 订阅名称
      type: [DYNAMIC_TYPE_WORD] # 原分类
    - {bot_id: 98, uid: '401742377', name: '另一机器人', type: []} # 另一机器人配置
  '78': [] # 保留空群
private:
  '42': # 私聊配置
    - {bot_id: 99, uid: '42', name: '好友', type: []}
custom: &custom {mode: legacy}
alias: *custom # 保留未使用的配置
`
  await writeFile(override,original)
  await chmod(override,0o664)
  const config=createSubscriptionConfig(root,lockFile)
  await config.update("bilibili",route,uid,"add",[draw],Object.keys(biliTypes),"不会覆盖旧显示名")
  const written=await readFile(override,"utf8")
  for (const comment of ["文件说明","目标群","订阅名称","原分类","另一机器人配置","保留空群","私聊配置","保留未使用的配置"]) {
    expect(written).toContain("# "+comment)
  }
  expect(written).toContain("*custom")
  expect(written).toContain("'78': []")
  expect((await stat(override)).mode & 0o777).toBe(0o664)
  const persisted=YAML.parse(written), before=YAML.parse(original)
  before.group[77][0].type.push(draw)
  expect(persisted).toEqual(before)

  await config.update("bilibili",route,uid,"add",[draw],Object.keys(biliTypes),"不变")
  expect(await readFile(override,"utf8")).toBe(written)
  await config.update("bilibili",route,uid,"remove",[],Object.keys(biliTypes),uid)
  const deleted=await readFile(override,"utf8")
  expect(deleted).toContain("# 另一机器人配置")
  expect(YAML.parse(deleted).group[77]).toEqual([before.group[77][1]])
})

test("旧 YAML 锚点复用的会话在修改或移除来源时保留自己的订阅",async()=>{
  const root=await directory()
  const dir=join(root,"yuki-plugin","config","bilibili")
  await mkdir(dir,{recursive:true})
  const file=join(dir,"push.yaml")
  const initial=`group:
  77: &shared
    - {bot_id: 99, uid: '${uid}', name: 原配置, type: [DYNAMIC_TYPE_WORD]}
  78: *shared # 另一个群
`
  const config=createSubscriptionConfig(root,lockFile)
  await writeFile(file,initial)
  await config.update("bilibili",route,uid,"add",[draw],Object.keys(biliTypes),uid)
  const edited=YAML.parse(await readFile(file,"utf8"))
  expect(edited.group[77][0].type).toEqual(["DYNAMIC_TYPE_WORD",draw])
  expect(edited.group[78][0].type).toEqual(["DYNAMIC_TYPE_WORD"])
  await writeFile(file,initial)
  await config.update("bilibili",route,uid,"remove",[],Object.keys(biliTypes),uid)
  const deleted=await readFile(file,"utf8")
  expect(deleted).toContain("# 另一个群")
  expect(YAML.parse(deleted)).toEqual({group:{78:[{bot_id:99,uid,name:"原配置",type:["DYNAMIC_TYPE_WORD"]}]}})
})

test("原动态订阅指令保留权限、别名、分类与当前会话",async()=>{
  const root=await directory()
  const provider={id:"bilibili",label:"B站",typeNames:biliTypes,profile:async uid=>({uid,name:"公开昵称"})}
  const plugin=await createSubscriptionModule({lockFile,groups:{}},{directory:root,providers:{bilibili:provider},getRedis:()=>undefined})
  try {
    const group={self_id:99,user_id:40,group_id:77,message_type:"group",isMaster:true}
    expect(await plugin.fallback("/yuki订阅哔哩推送 图文 UID："+uid,{...group,isMaster:false})).toContain("主人")
    expect(await plugin.fallback("/yuki订阅哔哩推送 图文 UID："+uid,group)).toContain("公开昵称")
    expect(await plugin.fallback("#B站订阅列表",{...group,isMaster:false})).toContain("[图文]")
    expect(await plugin.fallback("#B站订阅列表",{...group,group_id:78})).toContain("当前没有订阅")
    expect(await plugin.fallback("#执行B站任务",group)).toBe("订阅存储未连接。")
  } finally { await plugin.dispose() }
})

test("Milky 订阅管理仅接受宿主核验的当前会话主人",async()=>{
  const root=await directory()
  const provider={id:"bilibili",label:"B站",typeNames:biliTypes,profile:async uid=>({uid,name:"公开昵称"})}
  const plugin=await createSubscriptionModule({lockFile,groups:{}},{directory:root,providers:{bilibili:provider},getRedis:()=>undefined})
  try {
    const owner={adapter:"milky",self_id:98,user_id:42,message_type:"private",isMaster:false,isBotMaster:user=>user===42}
    const add="#添加B站推送 " + uid
    expect(await plugin.fallback(add,{...owner,user_id:43,isMaster:true})).toContain("主人")
    expect(await plugin.fallback(add,{...owner,isDelegated:true})).toContain("主人")
    expect(await plugin.fallback(add,{...owner,adapter:undefined})).toContain("主人")
    expect(await plugin.fallback(add,owner)).toContain("公开昵称")
    expect(await plugin.fallback("#B站全部订阅列表",owner)).toMatchObject({type:"forward",nodes:[expect.stringContaining("公开昵称")]})
    expect(await plugin.fallback("#执行B站任务",owner)).toBe("订阅存储未连接。")
  } finally { await plugin.dispose() }
})

test("全部订阅列表只列聊天所在机器人，授权终端可核对全部",async()=>{
  const root=await directory()
  const dir=join(root,"yuki-plugin","config","bilibili")
  await mkdir(dir,{recursive:true})
  await writeFile(join(dir,"push.yaml"),YAML.stringify({
    group:{77:[{bot_id:99,uid,name:"OneBot 群订阅",type:[draw]},{bot_id:98,uid,name:"Milky 群订阅",type:[]}]},
    private:{42:[{bot_id:98,uid,name:"Milky 私聊订阅",type:[article]}]},
  }))
  const provider={id:"bilibili",label:"B站",typeNames:biliTypes}
  const plugin=await createSubscriptionModule({lockFile,groups:{}},{directory:root,providers:{bilibili:provider},getRedis:()=>undefined})
  try {
    const command="/yukiB站全部推送列表"
    const oneBot={self_id:99,user_id:42,group_id:77,message_type:"group",isMaster:true}
    const milky={adapter:"milky",self_id:98,user_id:42,message_type:"private",isMaster:false,isBotMaster:id=>id===42}
    expect(await plugin.fallback(command,oneBot)).toEqual({type:"forward",nodes:[
      `群 77 · 机器人 99\n${uid}：OneBot 群订阅 [图文]`,
    ]})
    expect(await plugin.fallback(command,milky)).toEqual({type:"forward",nodes:[
      `群 77 · 机器人 98\n${uid}：Milky 群订阅 [全部动态]`,
      `私聊 42 · 机器人 98\n${uid}：Milky 私聊订阅 [文章]`,
    ]})
    expect(await plugin.fallback(command,{...oneBot,self_id:undefined})).toMatch(/查询当前会话/u)
    expect(await plugin.fallback(command,{...oneBot,self_id:97})).toMatch(/当前没有订阅/u)
    const terminal=await plugin.fallback(command,{message_type:"terminal",isMaster:true})
    expect(terminal.nodes).toHaveLength(3)
    expect(await plugin.fallback(command,{message_type:"terminal",isMaster:false})).toMatch(/只有机器人主人/u)
  } finally { await plugin.dispose() }
})

test("公开订阅帮助兼容旧前缀，渲染不可用时保留现有指令",async()=>{
  const root=await directory()
  const stub=()=>renderSubscriptionHelp(async()=>{ throw new Error("fixture render unavailable") })
  const plugin=await createSubscriptionModule({lockFile,groups:{}},{directory:root,providers:{},getRedis:()=>undefined,renderHelp:stub})
  try {
    const user={self_id:99,user_id:42,message_type:"private",isMaster:false}
    const help=await plugin.fallback("#优纪帮助",user)
    expect(help.type).toBe("text")
    expect(help.text).toContain("#B站订阅列表")
    expect(help.text).toContain("#执行微博任务")
    expect(help.text).toContain("直接发送视频链接")
    expect(help.text).not.toMatch(/扫码|Cookie|更新Yuki/iu)
    for (const command of ["/优纪帮助","#yuki帮助","/YUKI帮助"]) expect(await plugin.fallback(command,user)).toEqual(help)
    expect(await plugin.fallback("#帮助",user)).toBeUndefined()
    expect(await renderSubscriptionHelp(async()=>({png:Buffer.from([1])}))).toEqual({type:"image",file:Buffer.from([1])})
  } finally { await plugin.dispose() }
})

test("B站旧查人指令保留开放资料、搜索粉丝数和规范直播间链接",async()=>{
  const root=await directory()
  const paths=[]
  const provider=createBiliProvider({fetch:async (url,init)=>{
    paths.push(url.pathname)
    expect(init.credentials).toBe("omit")
    if (url.pathname === "/x/web-interface/card") return Response.json({code:0,data:{follower:0,card:{
      mid:uid,name:"公开昵称",sex:"保密",level_info:{current_level:6},attention:60,sign:"[CQ:at,qq=all]",
      live_room:{roomid:12,title:"公开直播",liveStatus:0,watched_show:{num:0},url:"https://fixture.invalid/"},
    }}})
    return Response.json({code:0,data:{result:[null,{mid:uid,uname:'<em class="keyword">公开</em>昵称',fans:123},
      {mid:123,uname:"另一账号",fans:"未知"},
    ]}})
  }})
  const plugin=await createSubscriptionModule({lockFile,groups:{}},{directory:root,providers:{bilibili:provider},getRedis:()=>undefined})
  try {
    const group={self_id:99,user_id:40,group_id:77,message_type:"group",isMaster:false}
    expect(await plugin.fallback("/优纪B站UP主UID:"+uid,group)).toEqual([{type:"text",text:["公开昵称 · UID "+uid,
      "性别：保密","等级：6","粉丝数：0","关注数：60","[CQ:at,qq=all]","直播间：公开直播","直播状态：未开播",
      "观看人数：0","直播链接：https://live.bilibili.com/12"].join("\n")}])
    expect(await plugin.fallback("#yukiB站UP主昵称：公开",group)).toEqual([{type:"text",text:
      `公开昵称 · UID ${uid}\n粉丝数：123\n\n另一账号 · UID 123`}])
    expect(paths).toEqual(["/x/web-interface/card","/x/web-interface/search/type"])
  } finally { await plugin.dispose() }
})

test("订阅去重沿用群或私聊旧键，并排除过期、转发、关键词和同群多机器人重复",async()=>{
  const confirmed=[]
  const kv=new Map()
  const legacy=receiptKey("bilibili",route,{id:"already"})
  kv.set(legacy,"1")
  const redis=mockReceipts(kv)
  const posts = (id,options={})=>({id,uid,type:draw,createdAt:seen,content:"准入",...options})
  let fetched=0
  const provider={id:"bilibili",label:"B站",fetchPosts:async()=>{
    fetched++
    return [posts("already"),posts("fresh"),posts("old",{createdAt:seen-7300}),posts("blocked",{content:"准入屏蔽"}),
      posts("forward",{type:"DYNAMIC_TYPE_FORWARD"}),posts("other",{content:"其他"})]
  }}
  const d=createSubscriptionDelivery({providers:{bilibili:provider},
    config:{settings:async()=>settingsFor({pushTransmit:0,whiteWordslist:["准入"],banWords:["屏蔽"],pushTaskLog:0}),
      routes:async()=>[route,{...route,bot:"98"}]},
    groups:{onlineBots:()=>[98,99],listGroups:async()=>[{id:77}],sendGroup:async(bot,group,text)=>{confirmed.push([bot,group,text]);return 123}},
    getRedis:()=>redis,now:()=>seen*1000,render:async (_,post)=>[post.id],
  })
  try {
    const report=await d.run("bilibili")
    expect(confirmed).toEqual([[99,77,"fresh"]])
    expect(report.confirmed).toBe(1)
    expect(fetched).toBe(1)
    expect(kv.get(receiptKey("bilibili",route,{id:"fresh"}))).toBe("1")
    expect(receiptKey("weibo",{...route,kind:"private",chat:"42"},{id:"12233"})).toBe("Yz:yuki:weibo:upPush:private:42:12233")
  } finally { await d.dispose() }
})

test("文字关键词检查转发与原帖链接，匹配屏蔽词时不写去重记录",async()=>{
  const kept={id:"12301",uid,type:"DYNAMIC_TYPE_FORWARD",createdAt:seen,title:"正文",
    url:"https://m.bilibili.com/dynamic/12301",forwarded:{url:"https://www.bilibili.com/read/cv456"}}
  const hidden={...kept,id:"12302",url:"https://m.bilibili.com/dynamic/12302",
    forwarded:{url:"https://www.bilibili.com/read/cv456?track=excluded"}}
  const provider={id:"bilibili",label:"B站",fetchPosts:async()=>[kept,hidden]}
  const kv=new Map(), confirmed=[]
  let picture=1
  const delivery=createSubscriptionDelivery({providers:{bilibili:provider},
    config:{settings:async()=>settingsFor({pushMsgMode:picture,whiteWordslist:["/read/cv456"],
      banWords:["?track=excluded"],pushTaskLog:0}),routes:async()=>[route]},
    groups:{onlineBots:()=>[99],listGroups:async()=>[{id:77}],sendGroup:async(bot,group,message)=>{
      confirmed.push(message)
      return 123
    }},
    getRedis:()=>mockReceipts(kv),now:()=>seen*1000,render:async(_,post)=>[post.id],
  })
  try {
    expect(await delivery.run("bilibili")).toMatchObject({confirmed:0})
    expect(kv.size).toBe(0)
    picture=0
    expect(await delivery.run("bilibili")).toMatchObject({confirmed:1})
    expect(confirmed).toEqual([kept.id])
    expect(kv.has(receiptKey("bilibili",route,hidden))).toBe(false)
  } finally { await delivery.dispose() }
})


function mockReceipts(kv) {
  return {
    get:async key=>kv.get(key) ?? null,
    set:async (key,value,{NX})=>{
      if (NX && kv.has(key)) return null
      kv.set(key,value)
      return "OK"
    },
    eval:async (script,{keys,arguments:[token,argument]})=>{
      if (script.includes("EXISTS")) {
        if (keys.some(key=>kv.has(key))) return 0
        for (const key of keys) kv.set(key,token)
      } else if (argument==="rejected") {
        for (const key of keys) if (kv.get(key)===token) kv.delete(key)
      } else if (keys.length===1) {
        if (kv.get(keys[0])===token) kv.set(keys[0],"1")
      } else {
        kv.set(keys[0],"1")
        kv.set(keys[1],argument)
      }
      return 1
    },
  }
}

test("B站直播全员提醒沿用旧群冷却和失败开关，提醒失败不影响动态",async()=>{
  const kv=new Map(), calls=[]
  const group88={...route,chat:"88"}, friend={...route,chat:"42",kind:"private"}
  const mark="Yz:yuki:bili:upPush:group:77:liveAtAllMark"
  const keyFor=id=>receiptKey("bilibili",route,{id})
  let decision="rejected", warn, id="1"
  const provider={id:"bilibili",label:"B站",fetchPosts:async()=>[
    {id,uid,createdAt:seen,type:"DYNAMIC_TYPE_LIVE_RCMD",content:"直播"},
  ]}
  const delivery=createSubscriptionDelivery({providers:{bilibili:provider},
    config:{settings:async()=>settingsFor({liveAtAll:1,liveAtAllGroupList:[77,42],liveAtAllErrMsg:warn,pushTaskLog:0}),
      routes:async()=>[route,group88,friend]},
    notifications:()=>[{botId:99,isGroupMember:async()=>true,isFriend:async()=>true,
      sendGroup:async (group,payload)=>{
        calls.push([group,payload])
        return Array.isArray(payload) ? decision : "confirmed"
      },sendPrivate:async (user,payload)=>{calls.push([user,payload]);return "confirmed"},
    }],
    getRedis:()=>mockReceipts(kv),now:()=>seen*1000,render:async (_,post)=>["动态 "+post.id],
  })
  try {
    expect((await delivery.run("bilibili")).confirmed).toBe(3)
    expect(calls[0]).toEqual([77,[{type:"at",qq:"all"}," B站 直播提醒"]])
    expect(calls[1]).toEqual([77,"直播动态发送@全体成员失败，请检查权限或平台是否支持"])
    expect(calls.slice(2)).toEqual([[77,"动态 1"],[88,"动态 1"],[42,"动态 1"]])
    expect(kv.has(mark)).toBe(false)
    expect(kv.get(keyFor("1"))).toBe("1")
    warn=0;id="2";calls.length=0
    await delivery.run("bilibili")
    expect(calls).toHaveLength(4)
    expect(kv.has(mark)).toBe(false)
    decision="unknown";id="3";calls.length=0
    await delivery.run("bilibili")
    expect(calls).toHaveLength(4)
    expect(kv.get(mark)).toBe("1")
    decision="confirmed";id="4";calls.length=0
    await delivery.run("bilibili")
    expect(calls).toEqual([[77,"动态 4"],[88,"动态 4"],[42,"动态 4"]])
  } finally { await delivery.dispose() }
})

test("沿用旧严格阈值，按会话累计文字和图数",()=>{
  const settings=settingsFor({})
  const img={type:"image",file:"https://i0.hdslb.com/demo.png"}
  const first={payloads:[["A".repeat(150),img]]}
  const second={payloads:[["B".repeat(150),img]]}
  expect(useDynamicForward([first,second],settings)).toBe(false)
  expect(useDynamicForward([first,second,{payloads:[img]}],settings)).toBe(true)
  expect(useDynamicForward([first,second,{payloads:["C"]}],settings)).toBe(true)
  expect(useDynamicForward([first,second,{payloads:[img]}],settingsFor({forwardSendDynamic:0}))).toBe(false)
})

for (const [decision,expected,groups] of [["confirmed","confirmed",0],["rejected","confirmed",2],["unknown","unknown",0]]) {
  test("后台长动态合并转发结果 "+decision+" 决定是否改用单条",async()=>{
    const kv=new Map(), calls=[]
    const second={...route,uid:"4051"}
    const provider={id:"bilibili",label:"B站",fetchPosts:async user=>[
      {id:"post-"+user,uid:user,type:draw,createdAt:user===uid?seen:seen-1,content:"批准"},
    ]}
    const delivery=createSubscriptionDelivery({
      providers:{bilibili:provider},
      config:{settings:async()=>settingsFor({getDataRandomDelay:0,pushTaskLog:0}),
        routes:async()=>[route,second]},
      notifications:()=>[{
        botId:99,
        isGroupMember:async (group,bot)=>group===77&&bot===99,
        sendGroup:async (group,payload)=>{calls.push(["group",group,payload]);return "confirmed"},
        sendForward:async (target,nodes)=>{calls.push(["forward",target,nodes]);return decision},
      }],
      getRedis:()=>mockReceipts(kv),now:()=>seen*1000,
      render:async (_,post)=>[[post.id,"传输内容".repeat(65)]],
    })
    try {
      const record=await delivery.run("bilibili")
      expect(record[expected]).toBe(2)
      expect(calls.filter(call=>call[0]==="group")).toHaveLength(groups)
      expect(calls[0]).toMatchObject(["forward",{groupId:77},["有新的B站动态了~",
        ["post-4051","传输内容".repeat(65)],["post-"+uid,"传输内容".repeat(65)]]])
      expect((await delivery.run("bilibili")).skipped).toBe(2)
      expect(calls.filter(call=>call[0]==="forward")).toHaveLength(1)
      expect(kv.get("lotus-yunzai:media:subscription:bilibili:group:77:post-"+uid)).toBe(expected)
      expect(kv.get(receiptKey("bilibili",route,{id:"post-"+uid}))).toBe("1")
    } finally { await delivery.dispose() }
  })
}
