import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import YAML, { type Document, type Node } from "yaml"
import type { LockSubscriptionFile, SubscriptionPlatform } from "./types.ts"

export interface SubscriptionDestination {
  kind: "group" | "private"
  chat: string
  bot: string
}

export interface SubscriptionRoute extends SubscriptionDestination {
  uid: string
  name: string
  types: string[]
}

export type EditableSubscriptionRoute = Omit<SubscriptionRoute, "bot" | "name">

export class SubscriptionRouteConflict extends Error {}
export class SubscriptionRouteUnauthorized extends Error {}

type RouteOperation = "add" | "remove"
type Mapping = Record<string, unknown>

function isList(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function isMapping(value: unknown): value is Mapping {
  return value !== null && typeof value === "object" && !isList(value)
}

function missingFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export function numericId(value: unknown) {
  const id = String(value ?? "")
  return /^[1-9]\d{0,19}$/u.test(id) ? id : undefined
}

function map(value: unknown, path: string): Mapping {
  if (isMapping(value)) return value
  throw new Error(path + " 须为 YAML 映射。")
}

async function read(path: string) {
  try {
    const raw = await readFile(path, "utf8")
    return { raw, data: map(YAML.parse(raw) ?? {}, path) }
  }
  catch (error) { if (!missingFile(error)) throw error }
}

async function writeDocument(path: string, document: Document, signal?: AbortSignal, authorize?: () => boolean) {
  let mode = 0o600
  try {
    const current = await lstat(path)
    if (!current.isFile()) throw new Error("订阅配置须为普通文件。")
    mode = current.mode & 0o777
  } catch (error) {
    if (!missingFile(error)) throw error
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
    if (authorize && !authorize()) throw new SubscriptionRouteUnauthorized()
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function detachRouteAliases(document: Document, parents: unknown[], subtree: unknown) {
  // Other conversations that reference the edited YAML nodes keep their previous values.
  const anchors = new Set<Node>()
  for (const node of parents) {
    if (YAML.isNode(node) && !YAML.isAlias(node) && node.anchor) anchors.add(node)
  }
  if (YAML.isNode(subtree)) YAML.visit(subtree, { Value(_key, node) { if (node.anchor) anchors.add(node) } })
  if (!anchors.size) return
  YAML.visit(document, { Alias(_key, alias, parents) {
    const source = alias.resolve(document)
    if (!source || !anchors.has(source) || parents.includes(source)) return
    const snapshot = document.createNode(alias.toJS(document))
    snapshot.comment = alias.comment
    snapshot.commentBefore = alias.commentBefore
    snapshot.spaceBefore = alias.spaceBefore
    return snapshot
  } })
}

function editRoute(document: Document, destination: SubscriptionDestination, destinations: Mapping,
  entries: unknown[], index: number, updated?: Mapping & { type: unknown[] }) {
  const scope = document.get(destination.kind, true)
  if (!YAML.isMap(scope)) {
    document.set(destination.kind, destinations)
    return
  }
  // Existing conversation keys may be YAML numbers or quoted strings.
  const key = scope.items.findLast(pair => String(YAML.isScalar(pair.key) ? pair.key.value : undefined) === destination.chat)?.key ?? destination.chat
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

function number(value: unknown, fallback: number, low: number, high: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= high ? value : fallback
}

function flag(value: unknown, fallback: boolean) {
  return value === undefined ? fallback : value === true || value === 1 || value === "1"
}

function words(value: unknown): string[] {
  return isList(value) ? value.filter(word => typeof word === "string").map(word => word.trim()).filter(Boolean) : []
}

export function settingsFor(value: Mapping, platform?: SubscriptionPlatform) {
  return {
    enable:flag(value.pushStatus,true),
    cron:typeof value.checkDynamicCD === "string" && value.checkDynamicCD.trim() || "*/23 * * * *",
    horizon:number(value.dynamicTimeRange,7200,1,259200),
    delay:number(value.getDataRandomDelay,platform === "weibo" ? 4000 : 8000,0,60000),
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
    splitHeight:number(value.splitHeight,8000,700,20000),
    noSplitHeight:number(value.noSplitHeight,7500,700,20000),
    liveAtAll:flag(value.liveAtAll,false),
    liveGroups:new Set((isList(value.liveAtAllGroupList) ? value.liveAtAllGroupList : []).map(numericId).filter(id => id !== undefined)),
    liveCooldown:number(value.liveAtAllCD,1800,1,86400),
    liveFailureNotice:flag(value.liveAtAllErrMsg,true),
    parseVideoLink:flag(value.parseVideoLink,true),
    sharedBiliLogin:flag(value.sharedBiliLogin,true),
    log:flag(value.pushTaskLog,true),
  }
}

export type SubscriptionSettings = ReturnType<typeof settingsFor>

export function routesFrom(value: Mapping): SubscriptionRoute[] {
  const routes: SubscriptionRoute[] = []
  for (const kind of ["group", "private"] as const) {
    const scope = value[kind]
    if (!isMapping(scope)) continue
    for (const [chat,items] of Object.entries(scope)) {
      if (!numericId(chat) || !isList(items)) continue
      for (const item of items) {
        if (!isMapping(item)) continue
        const uid = numericId(item.uid)
        const bot = numericId(item.bot_id)
        if (!uid || !bot) continue
        routes.push({ kind, chat, bot, uid, name:typeof item.name === "string" && item.name || uid,
          types:isList(item.type) ? item.type.filter(type => typeof type === "string") : [] })
      }
    }
  }
  return routes
}

export const subscriptionRouteKey = ({ kind, chat, uid }: EditableSubscriptionRoute) => kind + ":" + chat + ":" + uid

export function ownerRoutes(routes: readonly SubscriptionRoute[], bot: string): EditableSubscriptionRoute[] {
  return routes.filter(route => route.bot === bot)
    .map(({ kind, chat, uid, types }) => ({ kind, chat, uid, types }))
    .sort((left, right) => subscriptionRouteKey(left).localeCompare(subscriptionRouteKey(right)))
}

function editOwnerRoute(document: Document, bot: string, route: EditableSubscriptionRoute, remove: boolean,
  names: ReadonlyMap<string, string>) {
  const data = map(document.toJS() ?? {}, "订阅配置")
  const current = data[route.kind]
  const destinations = current === undefined ? {} : { ...map(current, route.kind) }
  const existing = destinations[route.chat] ?? []
  if (!isList(existing)) throw new SubscriptionRouteConflict()
  const entries = [...existing]
  const index = entries.findIndex(item => isMapping(item) && numericId(item.bot_id) === bot && numericId(item.uid) === route.uid)
  const previous = entries[index]
  const name = names.get(route.uid)
  if (!remove && !isMapping(previous) && !name) throw new SubscriptionRouteConflict()
  const updated = remove ? undefined : {
    ...(isMapping(previous) ? previous : { bot_id: Number(bot), uid: route.uid, name }),
    type: route.types,
  }
  if (updated) {
    if (index >= 0) entries[index] = updated
    else entries.push(updated)
  } else if (index >= 0) entries.splice(index, 1)
  if (entries.length) destinations[route.chat] = entries
  else delete destinations[route.chat]
  editRoute(document, { kind: route.kind, chat: route.chat, bot }, destinations, entries, index, updated)
}

export function changeTypes<T>(existing: readonly T[], selected: readonly T[], allTypes: readonly T[], operation: RouteOperation): T[] {
  if (operation === "remove" && !selected.length) return []
  const types = new Set(operation === "remove" && !existing.length ? allTypes : existing)
  for (const type of selected) {
    if (operation === "remove") types.delete(type)
    else types.add(type)
  }
  return [...types]
}

export function createSubscriptionConfig(dataDirectory: string, lockFile: LockSubscriptionFile) {
  const root = join(dataDirectory, "yuki-plugin","config")
  const file = (id: SubscriptionPlatform, name: string) => join(root,id,name + ".yaml")
  async function effective(id: SubscriptionPlatform, name: string) {
    const override = file(id,name + ".guoba.support")
    const preferred = await read(override)
    if (preferred !== undefined) return { path: override, ...preferred }
    const path = file(id,name)
    return { path, ...(await read(path) ?? { raw: "", data: {} }) }
  }
  return {
    async settings(id: SubscriptionPlatform) { return settingsFor((await effective(id,"config")).data, id) },
    async routes(id: SubscriptionPlatform) { return routesFrom((await effective(id,"push")).data) },
    async replaceOwnerRoutes(id: SubscriptionPlatform, bot: string, previous: readonly EditableSubscriptionRoute[],
      next: readonly EditableSubscriptionRoute[], names: ReadonlyMap<string, string>, authorize: () => boolean, signal: AbortSignal) {
      const folder = dirname(file(id, "push"))
      const assertAuthorized = () => {
        if (signal.aborted || !authorize()) throw new SubscriptionRouteUnauthorized()
      }
      assertAuthorized()
      await mkdir(folder, { recursive: true, mode: 0o700 })
      // The chat commands and the browser share the same lock and effective file.
      const lock = await lockFile(join(folder, ".push-lock.sqlite"), "订阅配置")
      try {
        assertAuthorized()
        const current = await effective(id, "push")
        const before = ownerRoutes(routesFrom(current.data), bot)
        if (!isDeepStrictEqual(before, previous)) throw new SubscriptionRouteConflict()
        if (isDeepStrictEqual(before, next)) return before
        const old = new Map(before.map(route => [subscriptionRouteKey(route), route]))
        const updated = new Map(next.map(route => [subscriptionRouteKey(route), route]))
        const document: Document = YAML.parseDocument(current.raw)
        if (document.errors.length || (document.contents && !YAML.isMap(document.contents))) throw new SubscriptionRouteConflict()
        if (!document.contents) document.contents = document.createNode({})
        for (const [key, route] of old) if (!updated.has(key)) editOwnerRoute(document, bot, route, true, names)
        for (const [key, route] of updated) if (!isDeepStrictEqual(old.get(key), route)) editOwnerRoute(document, bot, route, false, names)
        const saved = await effective(id, "push")
        if (saved.path !== current.path || saved.raw !== current.raw) throw new SubscriptionRouteConflict()
        assertAuthorized()
        await writeDocument(current.path, document, signal, authorize)
        return next
      } finally {
        lock.close()
      }
    },
    async editSettings(id: SubscriptionPlatform, changes: (current: SubscriptionSettings) => Mapping, signal?: AbortSignal) {
      const path = file(id, "config.guoba.support")
      const folder = dirname(path)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const lock = await lockFile(join(folder, ".config-lock.sqlite"), "动态推送设置")
      try {
        signal?.throwIfAborted()
        const { raw, data } = await effective(id, "config")
        const entries = Object.entries(changes(settingsFor(data, id)))
        if (!entries.length) return

        const document: Document = YAML.parseDocument(raw)
        if (!YAML.isMap(document.contents)) document.contents = document.createNode({})
        for (const [field, value] of entries) document.set(field, value)
        await writeDocument(path, document, signal)
      } finally {
        lock.close()
      }
    },
    async update(id: SubscriptionPlatform, destination: SubscriptionDestination, uid: string, operation: RouteOperation,
      selected: readonly string[], allTypes: readonly string[], name: string) {
      const folder = dirname(file(id,"push"))
      await mkdir(folder,{recursive:true,mode:0o700})
      const lock = await lockFile(join(folder,".push-lock.sqlite"),"订阅配置")
      try {
        const {path,raw,data} = await effective(id,"push")
        data[destination.kind] ??= {}
        const destinations = map(data[destination.kind],destination.kind)
        const entries = destinations[destination.chat] ?? []
        if (!isList(entries)) throw new Error("订阅会话须为列表。")
        const index = entries.findIndex(item => isMapping(item) &&
          numericId(item.uid) === uid && numericId(item.bot_id) === destination.bot)
        const item: unknown = entries[index]
        const existing = isMapping(item) ? item : undefined
        if (!existing && operation === "remove") return
        const previousTypes = isList(existing?.type) ? existing.type : []
        const types = changeTypes(previousTypes,selected,allTypes,operation)
        const result = { name: existing?.name || name, types }
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
        const document: Document = YAML.parseDocument(raw)
        if (!YAML.isMap(document.contents)) document.contents = document.createNode({})
        editRoute(document,destination,destinations,entries,index,updated)
        await writeDocument(path,document)
        return result
      } finally { lock.close() }
    },
  }
}
