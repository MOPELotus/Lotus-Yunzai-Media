import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { createHash } from "node:crypto"
import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { createBiliProvider } from "../subscriptions/bilibili/index.ts"
import { lockBiliLogin, readBiliCommentLogin } from "../subscriptions/session.ts"
import type { GetSubscriptionRedis } from "../subscriptions/types.ts"
import { biliCommentTarget, biliDecimalId } from "./comments.ts"
import { BilibiliService, biliDynamicId, isBiliVideoPage } from "./service.ts"

type Request = BilibiliService["fetch"]
const api = "https://api.bilibili.com"
const expired = $t("services.bilibili.comment-write.text_b4a8db42d4")
const missing = $t("services.bilibili.comment-write.text_04e4385b62")
const unknown = $t("services.bilibili.comment-write.text_725c2620c1")
const replay = $t("services.bilibili.comment-write.text_1cec89927a")

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function request(fetch: Request, url: URL, active: AbortSignal, options: RequestInit = {}) {
  return fetch(url.href, { ...options, credentials: "omit", redirect: "error",
    signal: AbortSignal.any([active, AbortSignal.timeout(10_000)]),
    headers: { Accept: "application/json", Referer: "https://www.bilibili.com/", "User-Agent": "Mozilla/5.0", ...options.headers },
  })
}

async function json(response: Response) {
  const limit = 2 * 1024 * 1024
  if (!response.ok || response.redirected || !response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel()
    throw new Error($t("services.bilibili.comment-write.text_c2f55af816"))
  }
  const chunks = []
  let size = 0
  for await (const bytes of response.body) {
    size += bytes.byteLength
    if (size > limit) throw new Error($t("services.bilibili.comment-write.text_579eff7c7e"))
    chunks.push(bytes)
  }
  return record(JSON.parse(Buffer.concat(chunks, size).toString("utf8")))
}

export function createBiliCommentWriter(fetch: Request = globalThis.fetch, getRedis: GetSubscriptionRedis) {
  const metadata = new BilibiliService({ fetch })
  const dynamic = createBiliProvider({ fetch })

  async function targetOf(url: URL, signal: AbortSignal) {
    const source = await metadata.resolveShortLink(url, signal)
    const dynamicId = biliDynamicId(source)
    if (dynamicId) return (await dynamic.fetchPost(dynamicId, signal))?.commentTarget
    if (!isBiliVideoPage(source)) return
    const id = source.pathname.split("/")[2]!
    const aid = /^av/i.test(id) ? id.slice(2).replace(/^0+/u, "") : undefined
    const bvid = aid ? undefined : "BV" + id.slice(2)
    const view = new URL("/x/web-interface/view", api)
    view.search = aid ? new URLSearchParams({ aid }).toString() : new URLSearchParams({ bvid: bvid! }).toString()
    const data = await json(await request(fetch, view, signal))
    const video = record(data.data)
    const target = biliCommentTarget(video.aid, 1)
    if (data.code === 0 && target && (aid ? target.oid === aid : video.bvid === bvid)) return target
  }

  return async (url: URL, text: string, context: MessageFallbackContext, active: AbortSignal) => {
    const peer = context.message_type === "group" ? context.group_id : context.user_id
    const { self_id: bot, user_id: owner, message_id: id } = context
    const allowed = () => !active.aborted && owner !== undefined && context.isBotMaster(owner) && !context.isDelegated
    if (!allowed() || !peer || !bot || !id || !Number.isSafeInteger(id)) return
    const redis = getRedis()
    if (!redis) return missing
    const key = "lotus:media:bili-comment:" + createHash("sha256").update(JSON.stringify([
      context.adapter ?? "onebot", bot, context.message_type, peer, id,
    ])).digest("hex")
    let lock: Awaited<ReturnType<typeof lockBiliLogin>>
    let dispatched = false
    try {
      if (await redis.get(key)) return replay
      const target = await targetOf(url, active)
      if (!allowed()) return
      if (!target) return $t("services.bilibili.comment-write.text_cca123f6ee")
      lock = await lockBiliLogin(redis)
      if (!lock) return $t("services.bilibili.comment-write.text_d256e8e810")
      if (await redis.get(key)) return replay
      const state = await readBiliCommentLogin(redis)
      const sess = state?.fields.get("SESSDATA")
      const csrf = state?.fields.get("bili_jct")
      const uid = state?.fields.get("DedeUserID")
      if (!sess || !csrf || !/^[\w-]{16,128}$/u.test(csrf) || !uid || !/^[1-9]\d{0,19}$/u.test(uid)) return missing
      const Cookie = `SESSDATA=${sess}; bili_jct=${csrf}; DedeUserID=${uid}`
      if (!allowed()) return
      const profile = await json(await request(fetch, new URL("/x/web-interface/nav", api), active, { headers: { Cookie } }))
      const identity = record(profile.data)
      if (!allowed()) return
      if (profile.code === -101 || identity.isLogin === false) return expired
      if (profile.code !== 0 || identity.isLogin !== true || biliDecimalId(identity.mid_str ?? identity.mid) !== uid) return $t("services.bilibili.comment-write.text_a8fc5ed63c")
      if (!allowed()) return
      if (await redis.set(key, "claimed", { NX: true, EX: 86_400 }) !== "OK") return replay
      const current = await readBiliCommentLogin(redis)
      if (!allowed()) return
      if (current?.fields.get("DedeUserID") !== uid || current.fields.get("SESSDATA") !== sess || current.fields.get("bili_jct") !== csrf) {
        return $t("services.bilibili.comment-write.text_7869275168")
      }
      dispatched = true
      const response = await request(fetch, new URL("/x/v2/reply/add", api), active, { method: "POST",
        headers: { Cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: "https://www.bilibili.com" },
        body: new URLSearchParams({ message: text, oid: target.oid, type: String(target.type), csrf }),
      })
      if (!allowed()) {
        await response.body?.cancel()
        return
      }
      if (response.status === 401) {
        await response.body?.cancel()
        return expired
      }
      const result = await json(response)
      if (!allowed()) return
      if (result.code === 0) {
        const reply = record(record(result.data).reply)
        const rpid = biliDecimalId(reply.rpid_str ?? reply.rpid)
        if (rpid && biliDecimalId(reply.oid_str ?? reply.oid) === target.oid && reply.type === target.type &&
            biliDecimalId(reply.mid_str ?? reply.mid ?? record(reply.member).mid) === uid) return $t("services.bilibili.comment-write.text_3b75199d3c", { "rpid": rpid })
        return unknown
      }
      if (result.code === -101 || result.code === -111) return expired
      if (result.code === 12025) return $t("services.bilibili.comment-write.text_81ef4fe4f5")
      if (result.code === 12002 || result.code === 12003 || result.code === 12052) return $t("services.bilibili.comment-write.text_cd3cf0ad7f")
      return Number.isInteger(result.code) ? $t("services.bilibili.comment-write.text_4ca7c04ebf") : unknown
    } catch { if (allowed()) return dispatched ? unknown : $t("services.bilibili.comment-write.text_3a87e1deda") }
    finally { await lock?.close().catch(() => {}) }
  }
}
