import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { lockFile } from "../../../../lib/file-lock.ts"
import { parseFriendList, type OwnerContactListSession } from "../../../../lib/owner-contact-list.ts"
import { readPanelJson } from "../../../../lib/panel.ts"
import { biliTypesLabels as biliTypes, createBiliProvider } from "./bilibili/index.ts"
import {
  createSubscriptionConfig, numericId, ownerRoutes, subscriptionRouteKey, SubscriptionRouteConflict, SubscriptionRouteUnauthorized,
  type EditableSubscriptionRoute,
} from "./config.ts"
import { subscriptionSession } from "./session.ts"
import { createWeiboProvider, weiboTypesLabels as weiboTypes } from "./weibo/index.ts"
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
    key: "routes", label: $t("services.subscriptions.panel.text_95465a8060"), type: "json",
    hint: $t("services.subscriptions.panel.text_99e66fa99f") +
      $t("services.subscriptions.panel.text_aa8f902fbf") +
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
      return Response.json({ message: $t("services.subscriptions.panel.text_c085c4d105") }, { status: 403 })
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
        return Response.json({ message: $t("services.subscriptions.panel.text_8707c39b88") }, { status: 403 })
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
      if (!groups || !friends || signal.aborted) return unavailable($t("services.subscriptions.panel.text_3a1dbf36b6"))
      const allowed = { group: new Set(groups.map(({ id }) => String(id))), private: new Set(friends.map(({ id }) => String(id))) }
      if (changed.some(route => !allowed[route.kind].has(route.chat))) {
        return Response.json({ message: $t("services.subscriptions.panel.text_604f72efa9") }, { status: 403 })
      }
      const added = new Set(changed.filter(route => !old.has(subscriptionRouteKey(route))).map(route => route.uid))
      const names = new Map<string, string>()
      for (const uid of added) {
        const result = await provider.profile(uid, { signal }).then(profile => ({ profile })).catch(() => undefined)
        if (!authorized()) return new Response(null, { status: 403 })
        if (!result || signal.aborted || result.profile?.verificationFailure) {
          return unavailable($t("services.subscriptions.panel.text_b8189cf5dd", { "uid": uid }))
        }
        const { profile } = result
        if (!profile || profile.uid !== uid || !profile.name.trim()) {
          return Response.json({ message: $t("services.subscriptions.panel.text_6a99163572", { "uid": uid }) }, { status: 400 })
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
