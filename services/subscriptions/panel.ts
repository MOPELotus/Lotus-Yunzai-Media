import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { lockFile } from "../../../../lib/file-lock.ts"
import { parseFriendList, type OwnerContactListSession } from "../../../../lib/owner-contact-list.ts"
import { readPanelJson } from "../../../../lib/panel.ts"
import { biliTypes, createBiliProvider } from "./bilibili/index.ts"
import {
  createSubscriptionConfig, numericId, ownerRoutes, subscriptionRouteKey, SubscriptionRouteConflict, SubscriptionRouteUnauthorized,
  type EditableSubscriptionRoute,
} from "./config.ts"
import { subscriptionSession } from "./session.ts"
import { createWeiboProvider, weiboTypes } from "./weibo/index.ts"
import type { SubscriptionPlatform, SubscriptionProvider, SubscriptionRedis } from "./types.ts"

const platforms = { bilibili: biliTypes, weibo: weiboTypes }
const maxRoutes = 500
const unavailable = (message: string) => Response.json({ message }, { status: 503 })

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
}

function snapshot(value: unknown): EditableSubscriptionRoute[] | undefined {
  const input = object(value)
  if (!input || Object.keys(input).length !== 1 || !Array.isArray(input.routes) || input.routes.length > maxRoutes) return
  const routes: EditableSubscriptionRoute[] = []
  const seen = new Set<string>()
  for (const item of input.routes as unknown[]) {
    const route = object(item)
    if (!route || Object.keys(route).length !== 4 || (route.kind !== "group" && route.kind !== "private") ||
      typeof route.chat !== "string" || !numericId(route.chat) || typeof route.uid !== "string" || !numericId(route.uid) ||
      !Array.isArray(route.types) || route.types.length > 30 ||
      !route.types.every(type => typeof type === "string" && type.length > 0 && type.length <= 128)) return
    const types = route.types as string[]
    const parsed: EditableSubscriptionRoute = { kind: route.kind, chat: route.chat, uid: route.uid, types }
    const key = subscriptionRouteKey(parsed)
    if (seen.has(key)) return
    seen.add(key)
    routes.push(parsed)
  }
  return routes.sort((left, right) => subscriptionRouteKey(left).localeCompare(subscriptionRouteKey(right)))
}

export function panelMediaSubscriptionSettings(root: URL, platform: SubscriptionPlatform,
  contactSession: (request: Request) => OwnerContactListSession | undefined, providerOptions?: Pick<SubscriptionProvider, "profile">) {
  const directory = fileURLToPath(new URL("data/", root))
  const config = createSubscriptionConfig(directory, lockFile)
  const session = subscriptionSession(platform, directory, () => (globalThis as { redis?: SubscriptionRedis }).redis)
  const provider = providerOptions ?? (platform === "bilibili" ? createBiliProvider({ session }) : createWeiboProvider({ session }))
  const labels = platforms[platform]
  const fields = [{
    key: "routes", label: "当前机器人的订阅名单", type: "json",
    hint: "每条填写 kind（group 群或 private 本人私聊）、chat（QQ 或群号）、uid（平台 UID）、types（动态类别）。" +
      "账号标识请用引号括起。types 填 [] 表示全部动态。支持的类别有 " +
      Object.entries(labels).map(([key, label]) => `${label} ${key}`).join("、") + "。",
  }]
  const output = (routes: readonly EditableSubscriptionRoute[]) => Response.json({ fields, values: { routes } })
  return async (request: Request, stillAuthorized: () => boolean): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } })
    }
    const gateway = contactSession(request)
    const bot = numericId(gateway?.botId)
    const authorized = () => !!gateway && !gateway.signal.aborted && !request.signal.aborted &&
      stillAuthorized() && gateway.authorized()
    if (!gateway || !bot || !authorized()) {
      return Response.json({ message: "请通过当前机器人私聊签发的面板链接登录，并保持机器人在线。" }, { status: 403 })
    }
    const signal = AbortSignal.any([request.signal, gateway.signal, AbortSignal.timeout(15_000)])
    try {
      if (request.method === "GET") {
        const routes = ownerRoutes(await config.routes(platform), bot)
        return authorized() ? output(routes) : new Response(null, { status: 403 })
      }
      const body = object(await readPanelJson(request, 512 * 1024).catch(() => undefined))
      const previous = snapshot(body?.previous), next = snapshot(body?.values)
      if (!body || Object.keys(body).length !== 2 || !previous || !next) return new Response(null, { status: 400 })
      if (!authorized()) return new Response(null, { status: 403 })
      const old = new Map(previous.map(route => [subscriptionRouteKey(route), route]))
      const changed = next.filter(route => !isDeepStrictEqual(old.get(subscriptionRouteKey(route)), route))
      const nextKeys = new Set(next.map(subscriptionRouteKey))
      const removed = previous.filter(route => !nextKeys.has(subscriptionRouteKey(route)))
      if ([...changed, ...removed].some(route => route.kind === "private" && route.chat !== String(gateway.ownerId))) {
        return Response.json({ message: "私聊订阅只能修改当前登录主人的本人会话。" }, { status: 403 })
      }
      if (changed.some(({ types }) => types.some(type => !Object.hasOwn(labels, type)) || new Set(types).size !== types.length)) {
        return new Response(null, { status: 400 })
      }
      const verifyGroups = changed.some(route => route.kind === "group")
      const verifyFriends = changed.some(route => route.kind === "private")
      const [groups, friends] = await Promise.all([
        verifyGroups ? gateway.groups(signal).catch(() => undefined) : [],
        verifyFriends ? gateway.friends(signal).then(parseFriendList).catch(() => undefined) : [],
      ])
      if (!authorized()) return new Response(null, { status: 403 })
      if (!groups || !friends || signal.aborted) return unavailable("暂时无法核对机器人的群和好友，请稍后重试。")
      const allowed = { group: new Set(groups.map(({ id }) => String(id))), private: new Set(friends.map(({ id }) => String(id))) }
      if (changed.some(route => !allowed[route.kind].has(route.chat))) {
        return Response.json({ message: "修改的目标须是当前机器人所在的群或已添加的好友。" }, { status: 403 })
      }
      const added = new Set(changed.filter(route => !old.has(subscriptionRouteKey(route))).map(route => route.uid))
      const names = new Map<string, string>()
      for (const uid of added) {
        const result = await provider.profile(uid, { signal }).then(profile => ({ profile })).catch(() => undefined)
        if (!authorized()) return new Response(null, { status: 403 })
        if (!result || signal.aborted || result.profile?.verificationFailure) {
          return unavailable(`暂时无法核验 UID ${uid} 的账号，请稍后重试。`)
        }
        const { profile } = result
        if (!profile || profile.uid !== uid || !profile.name.trim()) {
          return Response.json({ message: `未找到 UID ${uid} 的公开资料。` }, { status: 400 })
        }
        names.set(uid, profile.name)
      }
      return output(await config.replaceOwnerRoutes(platform, bot, previous, next, names, authorized, signal))
    } catch (error) {
      const status = error instanceof SubscriptionRouteConflict ? 409 : error instanceof SubscriptionRouteUnauthorized ? 403 : 500
      return new Response(null, { status })
    }
  }
}
