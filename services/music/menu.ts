import { loadImage, type Image } from "skia-canvas"
import { fetchImageBytes } from "../../core/render/image.ts"
import type { MusicListRow } from "../../core/render/source-cards.ts"
import { musicCoverSource, type MediaFetch } from "../media/cdn.ts"

export type MusicMenuRow = Omit<MusicListRow, "cover"> & { readonly coverUrl?: string; readonly coverPlatform?: string }

export function musicLength(milliseconds: unknown) {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds <= 0) return
  const seconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  return (hours ? hours + ":" + String(minutes).padStart(2, "0") : String(minutes)) + ":" + String(seconds % 60).padStart(2, "0")
}

export async function musicMenuCovers(rows: readonly MusicMenuRow[], signal: AbortSignal, fetch?: MediaFetch): Promise<MusicListRow[]> {
  const pending = new Map<string, Promise<Image | undefined>>()
  return Promise.all(rows.map(async ({ coverUrl, coverPlatform, ...row }) => {
    const source = coverPlatform && musicCoverSource(coverUrl, coverPlatform)
    if (!source) return row
    const url = source.url.href
    let loading = pending.get(url)
    if (!loading) {
      loading = fetchImageBytes(url, { fetch, signal, timeoutMs: 2500, maxBytes: 512 * 1024, musicCover: source.cdn })
        .then(bytes => loadImage(bytes))
        .then(image => image.width > 0 && image.height > 0 && image.width * image.height <= 4_000_000 ? image : undefined)
        .catch(() => undefined)
      pending.set(url, loading)
    }
    return { ...row, cover: await loading }
  }))
}
