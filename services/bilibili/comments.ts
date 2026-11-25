import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { readPublicResponse } from "../public-read.ts"
import type { BilibiliService } from "./service.ts"

export interface BiliCommentTarget { readonly oid: string; readonly type: number }
export interface BiliComment {
  readonly id: string
  readonly author: string
  readonly text: string
  readonly likes: number
  readonly images: readonly string[]
  readonly pinned?: true
}

const root = "https://api.bilibili.com"
const limit = 2 * 1024 * 1024

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function biliDecimalId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value)
  return typeof value === "string" && /^[1-9]\d{0,21}$/u.test(value) ? value : undefined
}

export function biliCommentTarget(oid: unknown, type: unknown): BiliCommentTarget | undefined {
  const id = biliDecimalId(oid)
  if (id && typeof type === "number" && Number.isInteger(type) && type > 0 && type <= 1000) return { oid: id, type }
}

function safeText(value: unknown, limit: number) {
  return typeof value === "string" ? Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "").trim()).slice(0, limit).join("") : ""
}

function commentOf(value: unknown, target: BiliCommentTarget, parent?: string): BiliComment | undefined {
  const row = record(value)
  if (biliDecimalId(row.oid_str ?? row.oid) !== target.oid || row.type !== target.type || row.invisible === true) return
  if (parent && biliDecimalId(row.root_str ?? row.root) !== parent) return
  const id = biliDecimalId(row.rpid_str ?? row.rpid)
  const content = record(row.content)
  const text = safeText(content.message, 2000)
  const images = (Array.isArray(content.pictures) ? content.pictures.slice(0, 9) : []).flatMap(item => {
    const value = record(item).img_src
    const url = typeof value === "string" && value.length <= 2048 && URL.parse(value)
    if (!url || url.protocol !== "https:" || url.port || url.username || url.password ||
        !["hdslb.com", "biliimg.com"].some(domain => url.hostname === domain || url.hostname.endsWith("." + domain))) return []
    return [url.href]
  })
  if (!id || !text && !images.length) return
  const likes = typeof row.like === "number" && Number.isSafeInteger(row.like) && row.like > 0 ? row.like : 0
  const author = safeText(record(row.member).uname, 80).replace(/\s+/gu, " ") || $t("services.bilibili.comments.text_dbb8915955")
  return { id, author, text, likes, images }
}

export function createBiliComments(fetch: BilibiliService["fetch"] = globalThis.fetch) {
  async function read(path: string, input: URLSearchParams, signal?: AbortSignal) {
    const url = new URL(path, root)
    url.search = input.toString()
    const timeout = AbortSignal.timeout(5_000)
    const active = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await readPublicResponse(fetch, url.href, { credentials: "omit", redirect: "error", signal: active,
      headers: { Referer: "https://www.bilibili.com/", "User-Agent": "Mozilla/5.0", Accept: "application/json" } })
    if (!response.ok || response.redirected || !response.body || Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel()
      throw new Error($t("services.bilibili.comments.text_4f8468aaef"))
    }
    let size = 0
    const parts = []
    for await (const part of response.body) {
      size += part.length
      if (size > limit) throw new Error($t("services.bilibili.comments.text_379b5c9b93"))
      parts.push(part)
    }
    signal?.throwIfAborted()
    const json = record(JSON.parse(Buffer.concat(parts, size).toString("utf8")))
    if (json.code === 12002 || json.code === -404) return
    if (json.code !== 0) throw new Error($t("services.bilibili.comments.text_4f8468aaef"))
    return record(json.data)
  }

  function query(target: BiliCommentTarget) {
    return new URLSearchParams({ oid: target.oid, type: String(target.type), ps: "20", pn: "1" })
  }

  function replies(value: unknown, target: BiliCommentTarget, parent?: string) {
    if (!Array.isArray(value)) return []
    const distinct = new Map<string, BiliComment>()
    for (const row of value.slice(0, 20)) {
      const comment = commentOf(row, target, parent)
      if (comment && !distinct.has(comment.id)) distinct.set(comment.id, comment)
    }
    return [...distinct.values()]
  }

  return {
    async firstPage(target: BiliCommentTarget, signal?: AbortSignal) {
      const input = query(target)
      input.set("sort", "1")
      input.set("nohot", "0")
      const page = await read("/x/v2/reply", input, signal)
      if (!page) return []
      const pinned = commentOf(record(page.upper).top, target)
      const list = replies(page.replies, target).filter(row => row.id !== pinned?.id).sort((a, b) => b.likes - a.likes)
      return (pinned ? [{ ...pinned, pinned: true as const }, ...list] : list).slice(0, 10)
    },
    async thread(target: BiliCommentTarget, parent: string, signal?: AbortSignal) {
      const input = query(target)
      input.set("root", parent)
      const page = await read("/x/v2/reply/reply", input, signal)
      if (!page) return []
      if (commentOf(page.root, target)?.id !== parent) throw new Error($t("services.bilibili.comments.text_edad986d33"))
      return replies(page.replies, target, parent)
    },
  }
}
