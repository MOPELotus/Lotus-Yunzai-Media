import { requestText, DouyinError, type RequestOptions } from "./http.ts"
import type { DouyinLiveTarget } from "./links.ts"

const flightRows = /<script(?:\s[^>]*)?>\s*self\.__rsc_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)\s*<\/script>/gu

interface PublicRoom {
  idStr?: string
  title?: string
  status?: number
  startTime?: number
  finishTime?: number
  userCount?: number
  owner?: { nickname?: string }
}

interface RoomPage {
  id?: string
  hasError?: boolean
  data?: { room?: PublicRoom }
}

function plain(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, limit) : ""
}

function findRoom(html: string, id: string): PublicRoom | undefined {
  for (const [, chunk] of html.matchAll(flightRows)) {
    if (!chunk) continue
    let rows: string
    try { rows = JSON.parse(chunk) as string } catch { continue }
    for (const row of rows.split("\n")) {
      const prefix = /^[a-f0-9]+:/u.exec(row)
      if (!prefix) continue
      let node: unknown
      try { node = JSON.parse(row.slice(prefix[0].length)) } catch { continue }
      if (!Array.isArray(node) || node[0] !== "$") continue
      const page = node[3] as RoomPage | undefined
      const room = page?.data?.room
      // The numeric room ID in the same page can be rounded. Use its string.
      if (page?.id === id && page.hasError === false && room?.idStr === id) return room
    }
  }
}

export async function readDouyinLive(target: DouyinLiveTarget,
  { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000, signal }: RequestOptions & { signal?: AbortSignal } = {}) {
  const { response, text } = await requestText(fetchImpl, target.url, { redirect: "error", credentials: "omit", signal },
    { timeoutMs, maxBytes: 2 * 1024 * 1024 })
  if (!response.ok) throw new DouyinError("live_page_http", `抖音直播页面 HTTP ${response.status}`)
  const room = findRoom(text, target.id)
  const title = plain(room?.title, 120)
  if (!room || !title) throw new DouyinError("live_room_unverified", "未能核实抖音直播间的公开资料")
  const finish = room.finishTime ?? 0
  const now = Date.now() / 1000
  const ended = room.status === 4 && Number.isSafeInteger(finish) && finish > 0 && finish >= (room.startTime ?? 0) && finish <= now
  const live = room.status === 2 && finish === 0
  const { userCount } = room
  return { title, host: plain(room.owner?.nickname, 60), status: ended ? "直播已结束" : live ? "直播中" : "直播状态待确认",
    viewers: typeof userCount === "number" && Number.isSafeInteger(userCount) && userCount >= 0 ? userCount : undefined }
}
