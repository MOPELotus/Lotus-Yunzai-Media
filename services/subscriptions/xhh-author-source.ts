import { createHash } from "node:crypto"
import type { DynamicPost } from "./types.ts"
import { authorVideoType } from "./xhh-author-store.ts"

// Bilibili's public WBI signing order used by the fixed old author archive client.
const mixin = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
] as const

type ReadBili = <T>(path: string, params: Record<string, string>, signal?: AbortSignal) => Promise<T | undefined>
type Nav = { wbi_img?: { img_url?: unknown; sub_url?: unknown } }
type Archive = { list?: { vlist?: unknown } }

function knownPicture(input: unknown) {
  if (typeof input !== "string" || input.length > 4096) return
  const parsed = URL.parse(input.startsWith("//") ? "https:" + input : input)
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port ||
      !["hdslb.com", "biliimg.com"].some(domain => parsed.hostname === domain || parsed.hostname.endsWith("." + domain))) return
  parsed.protocol = "https:"
  return parsed
}

function keyPart(value: unknown) {
  return /\/([a-f0-9]{32})\.[a-z]+$/iu.exec(knownPicture(value)?.pathname ?? "")?.[1]
}

function text(value: unknown, limit: number) {
  return typeof value === "string" ? value.trim().toWellFormed().slice(0, limit) : ""
}

export function createAuthorArchive(read: ReadBili, now = Date.now) {
  let key: { value: string; expires: number } | undefined
  return async (uid: string, signal?: AbortSignal): Promise<DynamicPost | undefined> => {
    if (!/^[1-9]\d{0,19}$/u.test(uid)) return
    if (!key || key.expires <= now()) {
      const nav = await read<Nav>("/x/web-interface/nav", {}, signal)
      const first = keyPart(nav?.wbi_img?.img_url)
      const second = keyPart(nav?.wbi_img?.sub_url)
      if (!first || !second) throw new Error("B 站投稿检索所需的公开签名字段不可用。")
      const value = first + second
      key = { value: mixin.slice(0, 32).map(index => value[index]).join(""), expires: now() + 20 * 60_000 }
    }
    const wall = Math.floor(now() / 1000)
    const params = { mid: uid, order: "pubdate", pn: "1", ps: "1", wts: String(wall) }
    const query = new URLSearchParams(params).toString()
    const signature = createHash("md5").update(query + key.value).digest("hex")
    const archive = await read<Archive>("/x/space/wbi/arc/search", { ...params, w_rid: signature }, signal)
    const items = archive?.list?.vlist
    if (!Array.isArray(items)) throw new Error("B 站投稿列表结构无效。")
    if (!items.length) return
    const latest = items[0] as Record<string, unknown> | undefined
    const bvid = latest?.bvid
    const createdAt = latest?.created
    const author = text(latest?.author, 80) || uid
    if (!latest || typeof bvid !== "string" || !/^BV[1-9A-Za-z]{10}$/u.test(bvid) ||
        (typeof latest.mid !== "string" && typeof latest.mid !== "number") || String(latest.mid) !== uid ||
        typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt <= 0 || createdAt > wall) {
      throw new Error("最新投稿与查询作者不匹配。")
    }
    return { id: bvid, uid, author, createdAt, type: authorVideoType, title: text(latest.title, 240),
      content: text(latest.description, 2000), url: "https://www.bilibili.com/video/" + bvid,
      images: [], cover: knownPicture(latest.pic)?.href }
  }
}
