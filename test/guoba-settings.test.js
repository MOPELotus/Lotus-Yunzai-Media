import { createPublicShareCommands } from "../services/public-share/command.ts"
import { loadPublicShareConfig } from "../core/config/global.ts"
import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import YAML from "yaml"
import { lockFile } from "../../../lib/file-lock.ts"
import { supportGuoba } from "../guoba.support.js"
import { createSubscriptionConfig } from "../services/subscriptions/config.ts"
import { createSubscriptionDelivery, useDynamicForward } from "../services/subscriptions/delivery.ts"
import { loadAcfunConfig, loadGlobalConfig } from "../core/config/global.ts"
import { createAcfunCommands } from "../services/acfun/command.ts"

const Result = {
  ok: () => ({ ok: true }),
  error: (_message, status) => ({ ok: false, status }),
}
const defaults = {
  pushMsgMode: 1, mergeTextPic: 1, forwardSendDynamic: 1, maxPicsForSingleMsg: 2, maxTextLengthForSingleMsg: 300,
  pushStatus: 1, checkDynamicCD: "*/23 * * * *",
  pushTransmit: 1, dynamicTimeRange: 7200, getDataRandomDelay: 8000, whiteWordslist: [], banWords: [],
  pushPicCountLimit: 9, pushContentLenLimit: 1000, pushContentLineLimit: 100,
  isSplit: 1, splitHeight: 8000, noSplitHeight: 7500, boxGrid: 1, pushTaskLog: 1,
}
const biliDefaults = { ...defaults, liveAtAll: 0, liveAtAllGroupList: [], liveAtAllCD: 1800,
  liveAtAllErrMsg: 1, parseVideoLink: 1, sharedBiliLogin: 1, biliPgcAuto: false, biliPgcQuality: 32, biliPgcDuration: 1800 }
const weiboDefaults = { ...defaults, getDataRandomDelay: 4000, parseWeiboLink: 1, parseWeiboPrivate: 0 }
const shareDefaults = { enable: true, private_preview: false }
const publicShareDefaults = { acfun: shareDefaults, weishi: shareDefaults, zuiyou: shareDefaults, wxchannels: shareDefaults, xhs: shareDefaults, xhh: shareDefaults }
const pipixiaDefaults = { enable: true, private: false }
const officialLinksDefaults = { youtube: true, youtubeMusic: true, telegram: true, v2ex: true, articles: true, x: true, private: false, trustedTelegramUsers: [], trustedXUsers: [], summaryEnabled: false, summaryMode: "general", summaryBaseUrl: "", summaryModel: "" }
const videoDefaults = { forwardMsg: true, cover: false, bh3: false, by: false, xbgd: false, groups: [], group_config: [] }

test("媒体延用旧安装的独立 TuneWeave 地址和点歌配置，现用主配置优先", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-media-global-config-"))
  const current = join(root, "config")
  const previous = join(root, "plugins/Lotus-ReFactor/config")
  const originalName = join(root, "plugins/Lotus-Plugin/config")
  const source = "# 旧部署地址\r\ntuneweave: {api_url: http://127.0.0.1:9781/preferred}\r\nmusic: {default_platform: qq}\r\nnetease_partner: {login_poll_ms: 100}\r\n"
  const conflict = "tuneweave: {api_url: http://127.0.0.1:9782/other}\nbilibili: {search_limit: 8}\n"
  const load = () => loadGlobalConfig(pathToFileURL(root + "/"))
  try {
    await Promise.all([current, previous, originalName].map(directory => mkdir(directory, { recursive: true })))
    await writeFile(join(previous, "global.yaml"), source)
    expect(await load()).toMatchObject({
      tuneweave: { api_url: "http://127.0.0.1:9781/preferred" },
      music: { default_platform: "qq" },
      netease_partner: { login_poll_ms: 100 },
    })
    await writeFile(join(originalName, "global.yaml"), conflict)
    await expect(load()).rejects.toThrow("旧 TuneWeave 服务地址不一致")
    await writeFile(join(current, "global.yaml"), "tuneweave: {api_url: http://127.0.0.1:9783/current}\nmusic: {enable: false}\n")
    expect(await load()).toMatchObject({
      tuneweave: { api_url: "http://127.0.0.1:9783/current" },
      music: { enable: false },
      bilibili: { search_limit: 8 },
    })
    expect((await load()).music.default_platform).toBeUndefined()
    expect(await readFile(join(previous, "global.yaml"), "utf8")).toBe(source)
    expect(await readFile(join(originalName, "global.yaml"), "utf8")).toBe(conflict)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("媒体面板沿用旧默认值和配置，保存后下次推送使用覆盖文件", async () => {
  const data = await mkdtemp(join(tmpdir(), "lotus-media-config-"))
  try {
    const { configInfo: form } = supportGuoba(data)
    expect(await form.getConfigData()).toEqual({ bilibili: biliDefaults, weibo: weiboDefaults, ...publicShareDefaults, pipixia: pipixiaDefaults, kuaishou: pipixiaDefaults, jike: pipixiaDefaults, xigua: pipixiaDefaults, officialLinks: officialLinksDefaults, officialVideo: videoDefaults })
    expect(existsSync(join(data, "yuki-plugin"))).toBe(false)

    const directory = join(data, "yuki-plugin", "config", "bilibili")
    await mkdir(directory, { recursive: true })
    const primary = join(directory, "config.yaml"), override = join(directory, "config.guoba.support.yaml")
    const original = "# 非面板配置保留\npushMsgMode: true\nmergeTextPic: 0\nforwardSendDynamic: 0\nmaxPicsForSingleMsg: 7\ncheckDynamicCD: '*/23 * * * *'\ncustom: { color: teal }\n"
    await writeFile(primary, original)

    const store = createSubscriptionConfig(data, lockFile)
    const nodes = [{ payloads: [[{ type: "image", file: "fixture.png" }]] }]
    expect(useDynamicForward(nodes, await store.settings("bilibili"))).toBe(false)
    expect(await form.getConfigData()).toEqual({ bilibili: {
      ...biliDefaults, mergeTextPic: 0, forwardSendDynamic: 0, maxPicsForSingleMsg: 7,
    }, weibo: weiboDefaults, ...publicShareDefaults, pipixia: pipixiaDefaults, kuaishou: pipixiaDefaults, jike: pipixiaDefaults, xigua: pipixiaDefaults, officialLinks: officialLinksDefaults, officialVideo: videoDefaults })
    expect(await form.setConfigData({ "bilibili.forwardSendDynamic": 0 }, { Result })).toEqual({ ok: true })
    expect(existsSync(override)).toBe(false)
    expect(await form.setConfigData({ "bilibili.pushMsgMode": 0, "bilibili.maxPicsForSingleMsg": 0.5 },
      { Result })).toEqual({ ok: false, status: 422 })
    expect(existsSync(override)).toBe(false)

    expect(await form.setConfigData({ "bilibili.pushMsgMode": 0, "bilibili.maxPicsForSingleMsg": 0,
      "bilibili.forwardSendDynamic": 1, "bilibili.custom": "unrecognized" }, { Result })).toEqual({ ok: true })
    expect(await readFile(primary, "utf8")).toBe(original)
    const raw = await readFile(override, "utf8")
    expect(raw).toContain("# 非面板配置保留")
    expect(YAML.parse(raw)).toMatchObject({
      pushMsgMode: 0, mergeTextPic: 0, forwardSendDynamic: 1, maxPicsForSingleMsg: 0,
      checkDynamicCD: "*/23 * * * *", custom: { color: "teal" },
    })

    const fresh = supportGuoba(data).configInfo
    expect(await fresh.getConfigData()).toEqual({ bilibili: {
      ...biliDefaults, pushMsgMode: 0, mergeTextPic: 0, maxPicsForSingleMsg: 0,
    }, weibo: weiboDefaults, ...publicShareDefaults, pipixia: pipixiaDefaults, kuaishou: pipixiaDefaults, jike: pipixiaDefaults, xigua: pipixiaDefaults, officialLinks: officialLinksDefaults, officialVideo: videoDefaults })
    expect(useDynamicForward(nodes, await store.settings("bilibili"))).toBe(true)
    expect(await fresh.setConfigData({ "bilibili.maxPicsForSingleMsg": 1 }, { Result })).toEqual({ ok: true })
    expect(useDynamicForward(nodes, await store.settings("bilibili"))).toBe(false)
  } finally {
    await rm(data, { force: true, recursive: true })
  }
})

test("媒体面板仅校验明确编辑项，保留旧直播冷却与未编辑平台", async () => {
  const data = await mkdtemp(join(tmpdir(), "lotus-media-edited-fields-"))
  try {
    const bilibili = join(data, "yuki-plugin/config/bilibili")
    const weibo = join(data, "yuki-plugin/config/weibo")
    await Promise.all([bilibili, weibo].map(path => mkdir(path, { recursive: true })))
    const oldBilibili = "# 旧直播配置\r\nliveAtAllCD: 30 # 原冷却\r\nparseVideoLink: 1\r\n"
    const oldWeibo = "# 旧微博配置\r\npushMsgMode: 0\r\n"
    const primaryBilibili = join(bilibili, "config.yaml"), primaryWeibo = join(weibo, "config.yaml")
    const overrideBilibili = join(bilibili, "config.guoba.support.yaml"), overrideWeibo = join(weibo, "config.guoba.support.yaml")
    await writeFile(primaryBilibili, oldBilibili)
    await writeFile(primaryWeibo, oldWeibo)
    const { configInfo: form } = supportGuoba(data)
    const expanded = { "bilibili.liveAtAllCD": 30, "weibo.pushMsgMode": 1 }
    expect((await form.getConfigData()).bilibili.liveAtAllCD).toBe(30)

    expect(await form.setConfigData(expanded, { Result, changedFields: ["weibo.pushMsgMode"] })).toEqual({ ok: true })
    expect((await form.getConfigData()).weibo.pushMsgMode).toBe(1)
    expect(YAML.parse(await readFile(overrideWeibo, "utf8"))).toEqual({ pushMsgMode: 1 })
    expect(existsSync(overrideBilibili)).toBe(false)
    expect(await form.setConfigData(expanded, { Result, changedFields: ["bilibili.liveAtAllCD"] })).toEqual({ ok: false, status: 422 })
    expect(await form.setConfigData(expanded, { Result })).toEqual({ ok: false, status: 422 })
    expect(existsSync(overrideBilibili)).toBe(false)

    expect(await form.setConfigData({ "bilibili.liveAtAllCD": 30, "bilibili.parseVideoLink": 0 }, {
      Result, changedFields: ["bilibili.parseVideoLink"],
    })).toEqual({ ok: true })
    expect(YAML.parse(await readFile(overrideBilibili, "utf8"))).toEqual({ liveAtAllCD: 30, parseVideoLink: 0 })
    expect(await readFile(primaryBilibili, "utf8")).toBe(oldBilibili)
    expect(await readFile(primaryWeibo, "utf8")).toBe(oldWeibo)
  } finally {
    await rm(data, { force: true, recursive: true })
  }
})

test("B站和微博图片布局沿用原开关与截图高度", async () => {
  const data = await mkdtemp(join(tmpdir(),"lotus-subscription-layout-"))
  try {
    const path = join(data,"yuki-plugin/config/weibo")
    await mkdir(path,{recursive:true})
    const base = join(path,"config.yaml"), override = join(path,"config.guoba.support.yaml")
    const original = "# 旧微博图片设置\nisSplit: false\nboxGrid: true\nsplitHeight: 16000\nnoSplitHeight: 20000\n"
    await writeFile(base,original)
    const {configInfo:form} = supportGuoba(data)
    expect((await form.getConfigData()).weibo).toMatchObject({isSplit:0,boxGrid:1})
    expect(await form.setConfigData({"bilibili.isSplit":0,"weibo.boxGrid":2},{Result})).toEqual({ok:false,status:422})
    expect(existsSync(override)).toBe(false)
    expect(await form.setConfigData({"weibo.isSplit":1,"weibo.boxGrid":0},{Result})).toEqual({ok:true})
    const config=createSubscriptionConfig(data,lockFile)
    expect(await config.settings("bilibili")).toMatchObject({split:true,grid:true})
    expect(await config.settings("weibo")).toMatchObject({split:true,grid:false,splitHeight:16000,noSplitHeight:20000})
    expect(await readFile(base,"utf8")).toBe(original)
    const raw = await readFile(override,"utf8")
    expect(raw).toContain("# 旧微博图片设置")
    expect(YAML.parse(raw)).toEqual({isSplit:1,boxGrid:0,splitHeight:16000,noSplitHeight:20000})
  } finally {
    await rm(data,{force:true,recursive:true})
  }
})

test("锅巴保存调度设置，重启后按平台注册任务且手动任务仍可执行", async () => {
  const data = await mkdtemp(join(tmpdir(), "lotus-subscription-cron-"))
  const config = createSubscriptionConfig(data, lockFile)
  const calls = []
  const providers = Object.fromEntries(["bilibili", "weibo"].map(id => [id, {
    id, async fetchPosts() { calls.push(id); return [] },
  }]))
  const dispatch = createSubscriptionDelivery({
    providers, config, notifications: () => [{ botId: 99, isFriend: async () => true }], getRedis: () => ({}),
  })
  try {
    const { configInfo: form } = supportGuoba(data)
    expect(form.schemas.find(field => field.field === "weibo.checkDynamicCD")?.component).toBe("EasyCron")
    expect(await form.setConfigData({ "bilibili.pushStatus": 0, "weibo.checkDynamicCD": "61 * * * *" }, { Result }))
      .toEqual({ ok: false, status: 422 })
    expect(existsSync(join(data, "yuki-plugin"))).toBe(false)
    expect(await form.setConfigData({ "bilibili.pushStatus": 0, "bilibili.checkDynamicCD": "* * * * * *",
      "weibo.checkDynamicCD": "  * * * * * *  " }, { Result })).toEqual({ ok: true })
    expect(await form.getConfigData()).toEqual({
      bilibili: { ...biliDefaults, pushStatus: 0, checkDynamicCD: "* * * * * *" },
      weibo: { ...weiboDefaults, checkDynamicCD: "* * * * * *" }, ...publicShareDefaults, pipixia: pipixiaDefaults, kuaishou: pipixiaDefaults, jike: pipixiaDefaults, xigua: pipixiaDefaults, officialLinks: officialLinksDefaults, officialVideo: videoDefaults,
    })
    for (const id of Object.keys(providers)) {
      await config.update(id, { kind: "private", bot: "99", chat: "42" }, "1234", "add", [], [], "测试号")
    }
    await dispatch.start()
    await Bun.sleep(1400)
    expect(calls.length).toBeGreaterThan(0)
    expect(new Set(calls)).toEqual(new Set(["weibo"]))
    await dispatch.run("bilibili")
    expect(calls).toContain("bilibili")
  } finally {
    await dispatch.dispose()
    await rm(data, { force: true, recursive: true })
  }
})

test("微博面板沿用旧覆盖文件并与 B 站独立保存", async () => {
  const data = await mkdtemp(join(tmpdir(), "lotus-weibo-guoba-"))
  try {
    const directory = join(data, "yuki-plugin", "config", "weibo")
    await mkdir(directory, { recursive: true })
    const primary = join(directory, "config.yaml")
    const override = join(directory, "config.guoba.support.yaml")
    const bilibili = join(data, "yuki-plugin", "config", "bilibili", "config.guoba.support.yaml")
    const original = "forwardSendDynamic: 1\npushMsgMode: 1\n"
    const previous = "# 微博旧面板设置\nforwardSendDynamic: 0\npushMsgMode: 0\nmergeTextPic: 0\nbanWords: [样例]\n"
    await writeFile(primary, original)
    await writeFile(override, previous)

    const { configInfo: form } = supportGuoba(data)
    expect(form.schemas.filter(({ field }) => field?.startsWith("weibo.")).map(({ field }) => field)).toEqual(
      Object.keys(weiboDefaults).map((key) => `weibo.${key}`),
    )
    expect(await form.getConfigData()).toEqual({ bilibili: biliDefaults, weibo: {
      ...weiboDefaults, pushMsgMode: 0, mergeTextPic: 0, forwardSendDynamic: 0, banWords: ["样例"],
    }, ...publicShareDefaults, pipixia: pipixiaDefaults, kuaishou: pipixiaDefaults, jike: pipixiaDefaults, xigua: pipixiaDefaults, officialLinks: officialLinksDefaults, officialVideo: videoDefaults })
    expect(await form.setConfigData({ "bilibili.pushMsgMode": 0, "weibo.maxTextLengthForSingleMsg": 50001 }, { Result }))
      .toEqual({ ok: false, status: 422 })
    expect(existsSync(bilibili)).toBe(false)
    expect(await readFile(override, "utf8")).toBe(previous)

    expect(await form.setConfigData({ "weibo.forwardSendDynamic": "1", "weibo.maxTextLengthForSingleMsg": 3 }, { Result }))
      .toEqual({ ok: true })
    const raw = await readFile(override, "utf8")
    expect(raw).toContain("# 微博旧面板设置")
    expect(YAML.parse(raw)).toEqual({ ...YAML.parse(previous), forwardSendDynamic: 1, maxTextLengthForSingleMsg: 3 })
    expect(await readFile(primary, "utf8")).toBe(original)
    expect(existsSync(bilibili)).toBe(false)

    const store = createSubscriptionConfig(data, lockFile)
    const nodes = [{ payloads: ["四个字啦"] }]
    expect(useDynamicForward(nodes, await store.settings("weibo"))).toBe(true)
    expect(useDynamicForward(nodes, await store.settings("bilibili"))).toBe(false)
    expect(await form.setConfigData({ "weibo.parseWeiboLink": 0, "weibo.parseWeiboPrivate": 1 }, { Result })).toEqual({ ok: true })
    expect(await store.settings("weibo")).toMatchObject({ parseWeiboLink: false, parseWeiboPrivate: true })
    expect(await form.setConfigData({ "bilibili.mergeTextPic": 0, "weibo.maxTextLengthForSingleMsg": 4 }, { Result }))
      .toEqual({ ok: true })
    expect(await form.getConfigData()).toEqual({ bilibili: { ...biliDefaults, mergeTextPic: 0 }, weibo: {
      ...weiboDefaults, pushMsgMode: 0, mergeTextPic: 0, maxTextLengthForSingleMsg: 4, banWords: ["样例"],
      parseWeiboLink: 0, parseWeiboPrivate: 1,
    }, ...publicShareDefaults, pipixia: pipixiaDefaults, kuaishou: pipixiaDefaults, jike: pipixiaDefaults, xigua: pipixiaDefaults, officialLinks: officialLinksDefaults, officialVideo: videoDefaults })
    expect(useDynamicForward(nodes, await store.settings("weibo"))).toBe(false)
  } finally {
    await rm(data, { force: true, recursive: true })
  }
})

test("B站视频解析开关保留旧文件覆盖和即时读取", async () => {
  const data = await mkdtemp(join(tmpdir(), "lotus-bili-auto-parse-"))
  try {
    const directory = join(data,"yuki-plugin/config/bilibili")
    const primary = join(directory,"config.yaml"), override = join(directory,"config.guoba.support.yaml")
    await mkdir(directory,{recursive:true})
    const original = "# 保留旧主配置\nparseVideoLink: false\n"
    await writeFile(primary,original)
    const {configInfo:form} = supportGuoba(data)
    const active = createSubscriptionConfig(data,lockFile)
    expect((await active.settings("bilibili")).parseVideoLink).toBe(false)
    expect((await form.getConfigData()).bilibili.parseVideoLink).toBe(0)
    expect(form.schemas.filter(field=>field.field?.endsWith(".parseVideoLink")).map(field=>field.field)).toEqual(["bilibili.parseVideoLink"])
    expect(await form.setConfigData({"bilibili.parseVideoLink":2},{Result})).toEqual({ok:false,status:422})
    expect(existsSync(override)).toBe(false)
    expect(await form.setConfigData({"bilibili.parseVideoLink":1},{Result})).toEqual({ok:true})
    expect((await active.settings("bilibili")).parseVideoLink).toBe(true)
    expect(await readFile(primary,"utf8")).toBe(original)
    expect(YAML.parse(await readFile(override,"utf8"))).toEqual({parseVideoLink:1})
  } finally {
    await rm(data,{force:true,recursive:true})
  }
})

test("B站直播提醒面板读写群名单和失败提示，长群号保留字符串", async () => {
  const data = await mkdtemp(join(tmpdir(),"lotus-bili-live-notice-"))
  try {
    const path = join(data,"yuki-plugin/config/bilibili")
    const base = join(path,"config.yaml"), override = join(path,"config.guoba.support.yaml")
    await mkdir(path,{recursive:true})
    const original = "# 旧群名单\nliveAtAllGroupList: [77, '88']\nliveAtAllErrMsg: false\n"
    await writeFile(base,original)
    const {configInfo:form} = supportGuoba(data)
    expect((await form.getConfigData()).bilibili).toMatchObject({
      liveAtAll: 0, liveAtAllGroupList: ["77", "88"], liveAtAllCD: 1800, liveAtAllErrMsg: 0,
    })
    expect(form.schemas.find(field => field.field === "bilibili.liveAtAllGroupList")).toMatchObject({
      component: "Select", componentProps: { mode: "tags" },
    })
    for (const bad of [{ "bilibili.liveAtAllCD": 59 }, { "bilibili.liveAtAllGroupList": ["01"] },
      { "bilibili.liveAtAllGroupList": [77] }, { "bilibili.liveAtAllErrMsg": "any text" }]) {
      expect(await form.setConfigData({ "bilibili.liveAtAll": 1, ...bad }, { Result })).toEqual({ ok: false, status: 422 })
    }
    expect(existsSync(override)).toBe(false)
    expect(await form.setConfigData({"bilibili.liveAtAll":1,"bilibili.liveAtAllCD":90},{Result})).toEqual({ok:true})
    const config = createSubscriptionConfig(data,lockFile)
    expect(await config.settings("bilibili")).toMatchObject({liveAtAll:true,liveGroups:new Set(["77","88"]),
      liveCooldown:90,liveFailureNotice:false})
    expect(await readFile(base,"utf8")).toBe(original)
    expect(await readFile(override,"utf8")).toContain("# 旧群名单")
    const targets = ["99", "90071992547409933"]
    expect(await form.setConfigData({
      "bilibili.liveAtAllGroupList": [" 99 ", ...targets], "bilibili.liveAtAllErrMsg": 1,
      "bilibili.sharedBiliLogin": 0,
    }, { Result })).toEqual({ ok: true })
    expect(await config.settings("bilibili")).toMatchObject({
      liveGroups: new Set(targets), liveFailureNotice: true, sharedBiliLogin: false,
    })
    expect(YAML.parse(await readFile(override, "utf8"))).toMatchObject({
      liveAtAllGroupList: targets, liveAtAllErrMsg: 1, sharedBiliLogin: 0,
    })
    expect(await form.setConfigData({ "bilibili.liveAtAllGroupList": [] }, { Result })).toEqual({ ok: true })
    expect((await config.settings("bilibili")).liveGroups.size).toBe(0)
    expect(await readFile(base, "utf8")).toBe(original)
  } finally {
    await rm(data,{force:true,recursive:true})
  }
})

test("恢复两平台旧推送过滤设置并保存为原 YAML 类型", async () => {
  const data = await mkdtemp(join(tmpdir(), "lotus-subscription-filters-"))
  try {
    const { configInfo: form } = supportGuoba(data)
    expect(form.schemas.find(field => field.field === "bilibili.banWords")).toMatchObject({
      component: "Select", componentProps: { mode: "tags" },
    })
    for (const values of [{ "weibo.banWords": ["文字", 13] }, { "weibo.dynamicTimeRange": 0 }]) {
      expect(await form.setConfigData({ "bilibili.pushTransmit": 0, ...values }, { Result }))
        .toEqual({ ok: false, status: 422 })
      expect(existsSync(join(data, "yuki-plugin"))).toBe(false)
    }
    const config = createSubscriptionConfig(data, lockFile)
    expect(await form.setConfigData({ "bilibili.banWords": [" 文字 ", " ", "[字面]"], "weibo.pushTransmit": 0,
      "weibo.dynamicTimeRange": "4500" }, { Result })).toEqual({ ok: true })
    expect(await config.settings("bilibili")).toMatchObject({ forwards: true, horizon: 7200, blacklist: ["文字", "[字面]"] })
    expect(await config.settings("weibo")).toMatchObject({ forwards: false, horizon: 4500, blacklist: [] })
    const path = join(data, "yuki-plugin", "config", "bilibili", "config.guoba.support.yaml")
    expect(YAML.parse(await readFile(path, "utf8"))).toEqual({ banWords: ["文字", "[字面]"] })
    expect(await form.setConfigData({ "bilibili.banWords": [] }, { Result })).toEqual({ ok: true })
    expect(YAML.parse(await readFile(path, "utf8"))).toEqual({ banWords: [] })
    expect(await form.setConfigData({
      "weibo.getDataRandomDelay": 3210, "weibo.whiteWordslist": [" 原神 "], "weibo.pushPicCountLimit": 3,
      "weibo.pushContentLenLimit": 700, "weibo.pushContentLineLimit": 12, "weibo.splitHeight": 1600,
      "weibo.noSplitHeight": 1400, "weibo.pushTaskLog": 0,
    }, { Result })).toEqual({ ok: true })
    expect(await config.settings("weibo")).toMatchObject({
      delay: 3210, whitelist: ["原神"], pictureLimit: 3, contentLimit: 700, lineLimit: 12,
      splitHeight: 1600, noSplitHeight: 1400, log: false,
    })
    expect(await config.settings("bilibili")).toMatchObject({
      delay: 8000, whitelist: [], pictureLimit: 9, contentLimit: 1000, log: true,
    })
  } finally {
    await rm(data, { force: true, recursive: true })
  }
})

test("AcFun 面板沿用已归档的旧开关，保存只改明确字段并即时控制入口", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-media-acfun-config-"))
  const root = pathToFileURL(dir + "/")
  const old = join(dir, "backup", "plugins", "rconsole-plugin", "config")
  const config = join(dir, "config")
  const file = join(config, "global.yaml")
  const original = "# 保留头注释\r\nother: {weight: 4, quiet: true}\r\n"
  const archived = "# 旧配置原样保留\r\nglobalBlackList: [Acfun, 微博]\r\nprivateResolve: true\r\n"
  const calls = []
  const link = "https://www.acfun.cn/v/ac48976163"
  const context = { message_type: "private", user_id: 123, self_id: 77, reply: async () => true }
  const plugin = createAcfunCommands({}, {
    loadConfig: async () => loadAcfunConfig(root),
    render: async () => new Uint8Array([1]),
    async fetch(url) {
      calls.push(url)
      return new Response('<script>window.pageInfo = window.videoInfo = {"dougaId":48976163,"title":"作品"};</script>')
    },
  })
  try {
    await Promise.all([mkdir(old, { recursive: true }), mkdir(config, { recursive: true })])
    await writeFile(join(old, "tools.yaml"), archived)
    await writeFile(file, original)
    const { configInfo: form } = supportGuoba(dir)
    expect(form.schemas.filter(item => item.field?.startsWith("acfun.")).map(item => [item.field, item.component]))
      .toEqual([["acfun.enable", "Switch"], ["acfun.private_preview", "Switch"]])
    expect((await form.getConfigData()).acfun).toEqual({ enable: false, private_preview: true })
    expect(await plugin.fallback(link, context)).toBeUndefined()
    expect(await plugin.fallback("#播放 " + link, { ...context, message_type: "group" })).toContain("未启用")
    expect(calls).toEqual([])
    expect(await form.setConfigData({ "acfun.enable": "false" }, { Result })).toEqual({ ok: false, status: 422 })
    expect(await readFile(file, "utf8")).toBe(original)
    expect(await form.setConfigData({ "acfun.enable": true, "acfun.private_preview": false, "bilibili.pushMsgMode": 0 },
      { Result, changedFields: ["acfun.enable"] })).toEqual({ ok: true })
    const current = await readFile(file, "utf8")
    expect(current).toBe(original + "acfun:\r\n  enable: true\r\n")
    expect((await form.getConfigData()).acfun).toEqual({ enable: true, private_preview: true })
    expect(await plugin.fallback(link, context)).toEqual([{ type: "image", file: new Uint8Array([1]) }, link])
    expect(calls).toEqual([link])
    expect(await form.setConfigData({ "acfun.private_preview": false }, { Result })).toEqual({ ok: true })
    expect((await form.getConfigData()).acfun).toEqual({ enable: true, private_preview: false })
    expect(await plugin.fallback(link, context)).toBeUndefined()
    await writeFile(file, "# 相邻字段\nother: &defaults {enable: true, color: red}\nacfun: *defaults\n")
    expect(await form.setConfigData({ "acfun.enable": false }, { Result })).toEqual({ ok: true })
    const withAlias = await readFile(file, "utf8")
    expect(withAlias).toContain("other: &defaults {enable: true, color: red}\n")
    expect(Bun.YAML.parse(withAlias)).toMatchObject({ acfun: { enable: false, color: "red" } })
    expect(await readFile(join(old, "tools.yaml"), "utf8")).toBe(archived)
  } finally {
    await plugin.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test("微视和最右面板分别继承旧解析开关，保存后按新值和权限调用入口", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-public-share-config-"))
  const root = pathToFileURL(dir + "/")
  const archive = join(dir, "backup", "plugins", "rconsole-plugin", "config")
  const config = join(dir, "config")
  const file = join(config, "global.yaml")
  const original = "# 注释应保留\npermissions:\n  scopes:\n    zuiyou.play: {policy: deny}\n"
  const old = "globalBlackList: [微视, Acfun]\nprivateResolve: false\n"
  const session = new AbortController()
  const calls = []
  const context = { message_type: "private", user_id: 123, self_id: 77, isMaster: false,
    privateCredentialSignal: session.signal, reply: async () => true }
  const weishi = "https://isee.weishi.qq.com/ws/app-pages/share/index.html?wxplay=1&id=7YaXkbaPB1WtR4KeU"
  const zuiyou = "https://share.xiaochuankeji.cn/hybrid/share/post?pid=340830632"
  const plugin = createPublicShareCommands({
    loadConfig: site => loadPublicShareConfig(site, root),
    render: async () => new Uint8Array([1]),
    async fetchPage(url) {
      calls.push(url)
      const body = url === weishi ? 'try { window.Vise.initState = {"feedsList":[{"id":"7YaXkbaPB1WtR4KeU","feedDesc":"样本"}]}; } catch {}'
        : 'window.APP_INITIAL_STATE={"sharePost":{"postDetail":{"post":{"id":340830632,"privateStatus":0,"content":"样本"}}}}'
      return new Response(`<script id="appState">${body}</script>`)
    },
  })
  try {
    await Promise.all([mkdir(archive, { recursive: true }), mkdir(config, { recursive: true })])
    await writeFile(join(archive, "tools.yaml"), old)
    await writeFile(file, original)
    const { configInfo: form } = supportGuoba(dir)
    expect(form.schemas.filter(item => /^(weishi|zuiyou)\./u.test(item.field ?? "")).map(item => [item.field, item.component]))
      .toEqual([["weishi.enable", "Switch"], ["weishi.private_preview", "Switch"], ["zuiyou.enable", "Switch"], ["zuiyou.private_preview", "Switch"]])
    expect(await form.getConfigData()).toMatchObject({ weishi: { enable: false, private_preview: false }, zuiyou: { enable: true, private_preview: false } })
    expect(await plugin.fallback(weishi, context)).toBeUndefined()
    expect(await plugin.fallback(zuiyou, context)).toBeUndefined()
    expect(await plugin.fallback("#播放 " + zuiyou, context)).toContain("未启用最右播放")
    expect(calls).toEqual([])
    expect(await form.setConfigData({ "weishi.enable": true, "weishi.private_preview": true, "zuiyou.enable": false },
      { Result, changedFields: ["weishi.enable", "weishi.private_preview"] })).toEqual({ ok: true })
    expect(await readFile(file, "utf8")).toBe(original + "weishi:\n  enable: true\n  private_preview: true\n")
    expect(await form.getConfigData()).toMatchObject({ weishi: { enable: true, private_preview: true }, zuiyou: { enable: true, private_preview: false } })
    expect(await plugin.fallback(weishi, context)).toMatchObject([{ type: "image" }, expect.stringContaining("样本")])
    expect(calls).toEqual([weishi])
    expect(await readFile(join(archive, "tools.yaml"), "utf8")).toBe(old)
  } finally {
    await plugin.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
