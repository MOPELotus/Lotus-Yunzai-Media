import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import YAML from "yaml"

export function numericId(value) {
  const id = String(value ?? "")
  return /^[1-9]\d{0,19}$/u.test(id) ? id : undefined
}

function map(value, path) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value
  throw new Error(path + " 须为 YAML 映射。")
}

async function read(path) {
  try { return map(YAML.parse(await readFile(path,"utf8")) ?? {}, path) }
  catch (error) { if (error.code !== "ENOENT") throw error }
}

function number(value, fallback, low, high) {
  return Number.isSafeInteger(value) && value >= low && value <= high ? value : fallback
}

function flag(value, fallback) {
  return value === undefined ? fallback : value === true || value === 1 || value === "1"
}

function words(value) {
  return Array.isArray(value) ? value.filter(word => typeof word === "string" && word.trim()).map(word => word.trim()) : []
}

export function settingsFor(value) {
  return {
    enable:flag(value.pushStatus,true),
    cron:typeof value.checkDynamicCD === "string" && value.checkDynamicCD.trim() || "*/23 * * * *",
    horizon:number(value.dynamicTimeRange,7200,1,259200),
    delay:number(value.getDataRandomDelay,8000,0,60000),
    forwards:flag(value.pushTransmit,true),
    picture:flag(value.pushMsgMode,true),
    pictureLimit:number(value.pushPicCountLimit,9,0,12),
    contentLimit:number(value.pushContentLenLimit,1000,0,8000),
    lineLimit:number(value.pushContentLineLimit,100,0,500),
    whitelist:words(value.whiteWordslist),
    blacklist:words(value.banWords),
    merge:flag(value.mergeTextPic,true),
    mergeForward:flag(value.forwardSendDynamic,true),
    forwardPictureThreshold:number(value.maxPicsForSingleMsg,2,0,100),
    forwardTextThreshold:number(value.maxTextLengthForSingleMsg,300,0,50000),
    grid:flag(value.boxGrid,true),
    split:flag(value.isSplit,true),
    splitHeight:number(value.splitHeight,8000,700,12000),
    noSplitHeight:number(value.noSplitHeight,7500,700,12000),
    liveAtAll:flag(value.liveAtAll,false),
    liveGroups:new Set((Array.isArray(value.liveAtAllGroupList) ? value.liveAtAllGroupList : []).map(numericId).filter(Boolean)),
    liveCooldown:number(value.liveAtAllCD,1800,1,86400),
    log:flag(value.pushTaskLog,true),
  }
}

export function routesFrom(value) {
  const routes = []
  for (const kind of ["group","private"]) {
    for (const [chat,items] of Object.entries(value[kind] ?? {})) {
      if (!numericId(chat) || !Array.isArray(items)) continue
      for (const item of items) {
        const uid = numericId(item?.uid)
        const bot = numericId(item?.bot_id)
        if (!uid || !bot) continue
        routes.push({ kind, chat, bot, uid, name:typeof item.name === "string" && item.name || uid,
          types:Array.isArray(item.type) ? item.type.filter(type => typeof type === "string") : [] })
      }
    }
  }
  return routes
}

export function changeTypes(existing, selected, allTypes, operation) {
  if (operation === "remove" && !selected.length) return []
  const types = new Set(operation === "remove" && !existing.length ? allTypes : existing)
  for (const type of selected) {
    if (operation === "remove") types.delete(type)
    else types.add(type)
  }
  return [...types]
}

export function createSubscriptionConfig(dataDirectory, lockFile) {
  const root = join(dataDirectory, "yuki-plugin","config")
  const file = (id, name) => join(root,id,name + ".yaml")
  async function effective(id,name) {
    const guoba = file(id,name + ".guoba.support")
    const preferred = await read(guoba)
    if (preferred !== undefined) return { path:guoba, data:preferred }
    const path = file(id,name)
    return {path,data:await read(path) ?? {}}
  }
  return {
    async settings(id) { return settingsFor((await effective(id,"config")).data) },
    async routes(id) { return routesFrom((await effective(id,"push")).data) },
    async update(id, destination, uid, operation, selected, allTypes, name) {
      const folder = dirname(file(id,"push"))
      await mkdir(folder,{recursive:true,mode:0o700})
      const lock = await lockFile(join(folder,".push-lock.sqlite"),"订阅配置")
      try {
        const {path,data} = await effective(id,"push")
        data[destination.kind] ??= {}
        const destinations = map(data[destination.kind],destination.kind)
        const entries = destinations[destination.chat] ?? []
        if (!Array.isArray(entries)) throw new Error("订阅会话须为列表。")
        const index = entries.findIndex(item => numericId(item?.uid) === uid && numericId(item?.bot_id) === destination.bot)
        const existing = entries[index]
        if (!existing && operation === "remove") return
        const types = changeTypes(Array.isArray(existing?.type) ? existing.type : [],selected,allTypes,operation)
        if (existing && operation === "remove" && !types.length) entries.splice(index,1)
        else if (existing) entries[index] = { ...existing, type:types }
        else entries.push({bot_id:Number(destination.bot),uid,name,type:types})
        if (entries.length) destinations[destination.chat] = entries
        else delete destinations[destination.chat]
        const temporary = path + "." + crypto.randomUUID() + ".tmp"
        try {
          await writeFile(temporary,YAML.stringify(data),{mode:0o600,flag:"wx"})
          await rename(temporary,path)
        } finally { await rm(temporary,{force:true}) }
        return { name:existing?.name || name, types }
      } finally { lock.close() }
    },
  }
}
