import { createHash } from "node:crypto"
import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { createBiliProvider } from "../subscriptions/bilibili/index.ts"
import { lockBiliLogin, readBiliCommentLogin } from "../subscriptions/session.ts"
import type { GetSubscriptionRedis } from "../subscriptions/types.ts"
import { biliCommentTarget, biliDecimalId } from "./comments.ts"
import { BilibiliService, biliDynamicId, isBiliVideoPage } from "./service.ts"

type Request = BilibiliService["fetch"]
const api = "https://api.bilibili.com"
const expired = "独立的 B 站动态登录已失效，请由主人在好友私聊重新扫码。"
const missing = "发评论需要独立的 B 站动态登录。请由主人在好友私聊发送 #扫码B站动态登录。"
const unknown = "B 站评论提交结果未确认，请先到原帖核对。"
const replay = "这条请求已经处理，请到原帖核对。"

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
    throw new Error("B 站接口没有返回可确认的数据。")
  }
  const chunks = []
  let size = 0
  for await (const bytes of response.body) {
    size += bytes.byteLength
    if (size > limit) throw new Error("B 站响应超出大小限制。")
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
    const aid = /^av/i.test(id) ? id.slice(2) : undefined
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
      if (!target) return "无法确认这条 B 站视频或动态的评论区。"
      lock = await lockBiliLogin(redis)
      if (!lock) return "B 站会话正在使用，请稍后再试。"
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
      if (profile.code !== 0 || identity.isLogin !== true || biliDecimalId(identity.mid_str ?? identity.mid) !== uid) return "B 站登录身份无法确认，评论未发送。"
      if (!allowed()) return
      if (await redis.set(key, "claimed", { NX: true, EX: 86_400 }) !== "OK") return replay
      const current = await readBiliCommentLogin(redis)
      if (!allowed()) return
      if (current?.fields.get("DedeUserID") !== uid || current.fields.get("SESSDATA") !== sess || current.fields.get("bili_jct") !== csrf) {
        return "B 站登录已变更，评论未发送。"
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
            biliDecimalId(reply.mid_str ?? reply.mid ?? record(reply.member).mid) === uid) return `B 站评论已发送，评论编号 ${rpid}。`
        return unknown
      }
      if (result.code === -101 || result.code === -111) return expired
      if (result.code === 12025) return "B 站未接受该评论，内容过长。"
      if (result.code === 12002 || result.code === 12003 || result.code === 12052) return "B 站已关闭这条内容的评论区。"
      return Number.isInteger(result.code) ? "B 站未接受这条评论。" : unknown
    } catch { if (allowed()) return dispatched ? unknown : "无法核实 B 站评论区或登录身份，评论未发送。" }
    finally { await lock?.close().catch(() => {}) }
  }
}
