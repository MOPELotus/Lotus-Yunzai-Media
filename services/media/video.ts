import fs from "node:fs/promises"
import path from "node:path"
import { resolveData, rootPath } from "../../core/path.ts"
import { runMediaProcess } from "./files.ts"

interface VideoOptions {
  readonly tools_path?: string
  readonly timeout_ms?: number
  readonly codec?: string
  readonly signal?: AbortSignal
}

interface Stream {
  readonly codec_type: string
  readonly codec_name?: string
}

function isStream(value: unknown): value is Stream {
  return Boolean(value && typeof value === "object" && "codec_type" in value && typeof value.codec_type === "string" &&
    (!("codec_name" in value) || typeof value.codec_name === "string"))
}

export async function findMediaTool(name: string, toolsPath = "data/tools/bin") {
  const configured = toolsPath === "data/tools/bin" ? resolveData("tools", "bin") : path.resolve(rootPath, toolsPath)
  for (const dir of [configured, ...(process.env.PATH || "").split(path.delimiter)]) {
    const file = path.join(dir, process.platform === "win32" ? `${name}.exe` : name)
    try { await fs.access(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return file } catch {}
  }
  return null
}

export async function prepareVideo(file: string, { tools_path, timeout_ms = 600000, codec, signal }: VideoOptions = {}) {
  const warnings: string[] = []
  const ffprobe = await findMediaTool("ffprobe", tools_path)
  let videoCodec = codec
  let audioOptions: string[] = []
  if (ffprobe) {
    const probe = await runMediaProcess(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", file], { cwd: path.dirname(file), timeoutMs: Math.min(timeout_ms, 30000), signal })
    const report: unknown = JSON.parse(probe.output)
    const raw = report && typeof report === "object" && "streams" in report ? report.streams : undefined
    const streams = Array.isArray(raw) ? raw.filter(isStream) : []
    const video = streams.find(stream => stream.codec_type === "video")
    if (!video) throw new Error("下载的文件没有可用视频流")
    videoCodec = video.codec_name
    audioOptions = streams.filter(stream => stream.codec_type === "audio").flatMap(({ codec_name }, index) =>
      codec_name && codec_name !== "aac" && codec_name !== "mp3" ? [`-c:a:${index}`, "aac"] : [])
  }
  const conversion = path.extname(file).toLowerCase() !== ".mp4" || (videoCodec && videoCodec !== "h264") || audioOptions.length > 0
  if (!conversion) return { file, warnings }
  const ffmpeg = await findMediaTool("ffmpeg", tools_path)
  if (!ffmpeg) return { file, warnings: ["未找到 FFmpeg，保留原视频文件，兼容性取决于客户端"] }
  const target = file.replace(/\.[^.]+$/, "-compatible.mp4")
  await runMediaProcess(ffmpeg, ["-nostdin", "-v", "error", "-i", file, "-map", "0:v:0", "-map", "0:a?",
    "-c:v", videoCodec === "h264" ? "copy" : "libx264", "-c:a", "copy", ...audioOptions, "-movflags", "+faststart", target],
  { cwd: path.dirname(file), timeoutMs: timeout_ms, signal })
  const stat = await fs.stat(target)
  if (!stat.size) throw new Error("FFmpeg 未生成有效视频")
  return { file: target, warnings }
}
