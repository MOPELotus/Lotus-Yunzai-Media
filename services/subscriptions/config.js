import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
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
  try {
    const raw = await readFile(path, "utf8")
    return { raw, data: map(YAML.parse(raw) ?? {}, path) }
  }
  catch (error) { if (error.code !== "ENOENT") throw error }
}

async function writeDocument(path, document, signal) {
  let mode = 0o600
  try {
    const current = await lstat(path)
    if (!current.isFile()) throw new Error("订阅配置须为普通文件。")
    mode = current.mode & 0o777
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const temporary = path + "." + crypto.randomUUID() + ".tmp"
  const file = await open(temporary, "wx", 0o600)
  try {
    try {
      await file.writeFile(document.toString())
      await file.chmod(mode)
    } finally {
      await file.close()
    }
    signal?.throwIfAborted()
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function detachRouteAliases(document, parents, subtree) {
  // Other conversations that reference the edited YAML nodes keep their previous values.
  const anchors = new Set(parents.filter(node => node?.anchor))
  if (subtree) YAML.visit(subtree, { Value(_key, node) { if (node.anchor) anchors.add(node) } })
  if (!anchors.size) return
  YAML.visit(document, { Alias(_key, alias, parents) {
    const source = alias.resolve(document)
    if (!anchors.has(source) || parents.includes(source)) return
    const snapshot = document.createNode(alias.toJS(document))
    snapshot.comment = alias.comment
    snapshot.commentBefore = alias.commentBefore
    snapshot.spaceBefore = alias.spaceBefore
    return snapshot
  } })
}

function editRoute(document, destination, destinations, entries, index, updated) {
  const scope = document.get(destination.kind, true)
  if (!YAML.isMap(scope)) {
    document.set(destination.kind, destinations)
    return
  }
  // Existing conversation keys may be YAML numbers or quoted strings.
  const key = scope.items.findLast(pair => String(pair.key?.value) === destination.chat)?.key ?? destination.chat
  const list = scope.get(key, true)
  const item = index >= 0 && YAML.isSeq(list) ? list.get(index, true) : undefined
  const type = YAML.isMap(item) ? item.get("type", true) : undefined
  detachRouteAliases(document, [scope,list,item], !entries.length ? list : !updated ? item : type)
  if (!entries.length) {
    scope.delete(key)
    return
  }
  if (!YAML.isSeq(list)) {
    scope.set(key, entries)
    return
  }
  if (!updated) list.delete(index)
  else if (index < 0) list.add(updated)
  else {
    if (!YAML.isMap(item)) {
      list.set(index, updated)
      return
    }
    if (YAML.isSeq(type)) {
      type.items = updated.type.map(value =>
        type.items.find(node => YAML.isScalar(node) && node.value === value) ?? document.createNode(value),
      )
    } else item.set("type", updated.type)
  }
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
    liveFailureNotice:flag(value.liveAtAllErrMsg,true),
    parseVideoLink:flag(value.parseVideoLink,true),
    sharedBiliLogin:flag(value.sharedBiliLogin,true),
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
    const override = file(id,name + ".guoba.support")
    const preferred = await read(override)
    if (preferred !== undefined) return { path: override, ...preferred }
    const path = file(id,name)
    return { path, ...(await read(path) ?? { raw: "", data: {} }) }
  }
  return {
    async settings(id) { return settingsFor((await effective(id,"config")).data) },
    async routes(id) { return routesFrom((await effective(id,"push")).data) },
    async editSettings(id, changes, signal) {
      const path = file(id, "config.guoba.support")
      const folder = dirname(path)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const lock = await lockFile(join(folder, ".config-lock.sqlite"), "动态推送设置")
      try {
        signal?.throwIfAborted()
        const { raw, data } = await effective(id, "config")
        const entries = Object.entries(changes(settingsFor(data)))
        if (!entries.length) return

        const document = YAML.parseDocument(raw)
        if (!YAML.isMap(document.contents)) document.contents = document.createNode({})
        for (const [field, value] of entries) document.set(field, value)
        await writeDocument(path, document, signal)
      } finally {
        lock.close()
      }
    },
    async update(id, destination, uid, operation, selected, allTypes, name) {
      const folder = dirname(file(id,"push"))
      await mkdir(folder,{recursive:true,mode:0o700})
      const lock = await lockFile(join(folder,".push-lock.sqlite"),"订阅配置")
      try {
        const {path,raw,data} = await effective(id,"push")
        data[destination.kind] ??= {}
        const destinations = map(data[destination.kind],destination.kind)
        const entries = destinations[destination.chat] ?? []
        if (!Array.isArray(entries)) throw new Error("订阅会话须为列表。")
        const index = entries.findIndex(item => numericId(item?.uid) === uid && numericId(item?.bot_id) === destination.bot)
        const existing = entries[index]
        if (!existing && operation === "remove") return
        const previousTypes = Array.isArray(existing?.type) ? existing.type : []
        const types = changeTypes(previousTypes,selected,allTypes,operation)
        const result = { name:existing?.name || name, types }
        const removed = existing && operation === "remove" && !types.length
        if (existing && !removed && types.length === previousTypes.length &&
            types.every((type, position) => type === previousTypes[position])) return result
        const updated = removed ? undefined
          : existing ? { ...existing, type:types } : {bot_id:Number(destination.bot),uid,name,type:types}
        if (!updated) entries.splice(index,1)
        else if (existing) entries[index] = updated
        else entries.push(updated)
        if (entries.length) destinations[destination.chat] = entries
        else delete destinations[destination.chat]
        const document = YAML.parseDocument(raw)
        if (!YAML.isMap(document.contents)) document.contents = document.createNode({})
        editRoute(document,destination,destinations,entries,index,updated)
        await writeDocument(path,document)
        return result
      } finally { lock.close() }
    },
  }
}
