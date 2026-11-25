import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { readFile } from "node:fs/promises"
import { readOptionalConfigFile } from "../../../../lib/config.ts"
import { dataPath, rootPath } from "../../core/path.ts"

export type SummaryModelMode = "general" | "yuanbao"
export interface SummaryModelSettings {
  readonly summaryEnabled: boolean
  readonly summaryMode: SummaryModelMode
  readonly summaryBaseUrl: string
  readonly summaryModel: string
  readonly summaryApiKeyConfigured: boolean
}
export interface SummaryModelPatch {
  summaryEnabled?: boolean
  summaryMode?: SummaryModelMode
  summaryBaseUrl?: string
  summaryModel?: string
  summaryApiKey?: string | null
}

type SummaryFetch = (url: URL, init: RequestInit) => Promise<Response>
type SummaryInput = { readonly title?: string; readonly text: string }
export const maxSummaryInput = 24_000
const maxResponse = 96 * 1024
const maxSummary = 6_000
const summaryPrompt = $t("services.official-links.summary-model.text_0d7ca9f7c8")

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
}

function mode(value: unknown): SummaryModelMode | undefined {
  if (value === "general" || value === "yuanbao") return value
}

function baseUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return
  const url = URL.parse(value.trim())
  if (!url || url.username || url.password || url.search || url.hash || !/^https?:\/\//iu.test(value.trim()) ||
      /[\\\u0000-\u0020\u007f]/u.test(value.trim())) return
  if (url.protocol !== "https:" && (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return
  return url
}

function endpoint(value: string) {
  const url = baseUrl(value)
  if (!url) return
  const path = url.pathname.replace(/\/+$/u, "")
  url.pathname = path.endsWith("/chat/completions") ? path : (path || "/v1") + "/chat/completions"
  return url
}

function modelName(value: unknown) {
  if (typeof value === "string" && /^[A-Za-z0-9._:/-]{1,180}$/u.test(value.trim())) return value.trim()
}

function apiKey(value: unknown) {
  if (typeof value === "string" && /^[\x21-\x7e]{1,2048}$/u.test(value.trim())) return value.trim()
}

/** Form validation. An empty password field keeps the stored value; null clears it. */
export function parseSummaryModelPatch(value: unknown): SummaryModelPatch | undefined {
  const raw = record(value)
  if (!raw) return
  const patch: SummaryModelPatch = {}
  for (const [key, item] of Object.entries(raw)) {
    switch (key) {
      case "summaryEnabled":
        if (typeof item !== "boolean") return
        patch.summaryEnabled = item
        break
      case "summaryMode": {
        const parsed = mode(item)
        if (!parsed) return
        patch.summaryMode = parsed
        break
      }
      case "summaryBaseUrl":
        if (typeof item !== "string" || item.trim() && !baseUrl(item)) return
        patch.summaryBaseUrl = item.trim()
        break
      case "summaryModel":
        if (typeof item !== "string" || item.trim() && !modelName(item)) return
        patch.summaryModel = item.trim()
        break
      case "summaryApiKey":
        if (item === null) patch.summaryApiKey = null
        else if (typeof item !== "string" || item.trim() && !apiKey(item)) return
        else if (item.trim()) patch.summaryApiKey = item.trim()
        break
      default: return
    }
  }
  return patch
}

async function readSettings(file: string, root: URL) {
  let current: Record<string, unknown> = {}
  try {
    const parsed = record(Bun.YAML.parse(await readFile(file, "utf8")))
    if (!parsed) throw new Error()
    current = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error($t("services.official-links.summary-model.text_04ee40f9e6"))
  }
  let legacy: Record<string, unknown> | undefined
  if (["summaryMode", "summaryBaseUrl", "summaryModel", "summaryApiKey"].some(key => !Object.hasOwn(current, key))) {
    try {
      legacy = await readOptionalConfigFile(root, "plugins/rconsole-plugin/config/tools.yaml") ??
        await readOptionalConfigFile(root, "backup/plugins/rconsole-plugin/config/tools.yaml")
    } catch { throw new Error($t("services.official-links.summary-model.text_43147e1bf9")) }
  }
  const get = (key: string, oldKey: string) => Object.hasOwn(current, key) ? current[key] : legacy?.[oldKey]
  const base = baseUrl(get("summaryBaseUrl", "aiBaseURL"))
  // Inherited credentials belong to the old service origin.
  const inheritedKey = base && base.origin === baseUrl(legacy?.aiBaseURL)?.origin ? legacy?.aiApiKey : undefined
  const key = apiKey(Object.hasOwn(current, "summaryApiKey") ? current.summaryApiKey : inheritedKey)
  const selectedMode = mode(get("summaryMode", "linkSummaryResolveMode"))
  const settings: SummaryModelSettings = {
    summaryEnabled: current.summaryEnabled === true,
    summaryMode: selectedMode ?? "general",
    summaryBaseUrl: base?.href.replace(/\/+$/u, "") ?? "",
    summaryModel: modelName(get("summaryModel", "aiModel")) ?? "",
    summaryApiKeyConfigured: Boolean(key),
  }
  if (Object.hasOwn(current, "summaryMode") && !selectedMode) throw new Error($t("services.official-links.summary-model.text_65d3e61e82"))
  return { settings, key }
}

async function readSummaryResponse(response: Response, signal: AbortSignal, secret: string) {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw new Error($t("services.official-links.summary-model.text_d9ed98ad57"))
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  let bytes = 0
  let body = ""
  try {
    if (Number(response.headers.get("content-length")) > maxResponse) throw new Error($t("services.official-links.summary-model.text_785671e48a"))
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read().catch(() => { throw new Error($t("services.official-links.summary-model.text_0bb9de71a4")) })
      signal.throwIfAborted()
      if (done) break
      bytes += value.length
      if (bytes > maxResponse) throw new Error($t("services.official-links.summary-model.text_785671e48a"))
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
  } finally {
    signal.removeEventListener("abort", cancel)
    cancel()
    reader.releaseLock()
  }
  let root
  try { root = record(JSON.parse(body)) }
  catch { throw new Error($t("services.official-links.summary-model.text_13a0438686")) }
  const choice = Array.isArray(root?.choices) && root.choices.length === 1 ? record(root.choices[0]) : undefined
  const message = record(choice?.message)
  if (choice?.finish_reason === "tool_calls" || choice?.finish_reason === "function_call" ||
      message?.function_call || (Array.isArray(message?.tool_calls) ? message.tool_calls.length > 0 : message?.tool_calls != null)) {
    throw new Error($t("services.official-links.summary-model.text_67c3a808a4"))
  }
  if (choice?.finish_reason === "length") throw new Error($t("services.official-links.summary-model.text_12b3e35163"))
  const content = typeof message?.content === "string" ? message.content.trim() : ""
  if (choice?.finish_reason !== "stop" || !content || content.length > maxSummary || content.includes(secret)) {
    throw new Error($t("services.official-links.summary-model.text_de6b376dd6"))
  }
  return content.toWellFormed()
}

export function createSummaryModel({ directory = dataPath,
  root = pathToFileURL((directory === dataPath ? rootPath : directory) + "/"), fetcher = fetch, timeoutMs = 20_000,
}: { readonly directory?: string; readonly root?: URL; readonly fetcher?: SummaryFetch; readonly timeoutMs?: number } = {}) {
  const file = join(directory, "media", "official-links.yaml")
  return {
    async settings() { return (await readSettings(file, root)).settings },
    async summarize({ title, text }: SummaryInput, signal?: AbortSignal, allowYuanbaoFallback = false) {
      signal?.throwIfAborted()
      const { settings, key } = await readSettings(file, root)
      if (!settings.summaryEnabled) throw new Error($t("services.official-links.summary-model.text_1ff7db8e8d"))
      if (settings.summaryMode !== "general" && !allowYuanbaoFallback) throw new Error($t("services.official-links.summary-model.text_9135e9981a"))
      const target = endpoint(settings.summaryBaseUrl)
      if (!target || !key || !settings.summaryModel) throw new Error($t("services.official-links.summary-model.text_23b6053f06"))
      const source = text.trim()
      if (!source || source.length > maxSummaryInput || (title?.length ?? 0) > 500) throw new Error($t("services.official-links.summary-model.text_e3ba475122"))
      const active = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
      let response: Response
      try {
        response = await fetcher(target, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
          body: JSON.stringify({ model: settings.summaryModel, stream: false, max_tokens: 700, messages: [
            { role: "system", content: summaryPrompt },
            { role: "user", content: JSON.stringify({ title: title?.trim().toWellFormed(), text: source.toWellFormed() }) },
          ] }),
          signal: active, redirect: "error", credentials: "omit",
        })
      } catch {
        signal?.throwIfAborted()
        throw new Error(active.aborted ? $t("services.official-links.summary-model.text_77d22441ed") : $t("services.official-links.summary-model.text_0eb16a51cd"))
      }
      try { return await readSummaryResponse(response, active, key) }
      catch (error) {
        signal?.throwIfAborted()
        if (active.aborted) throw new Error($t("services.official-links.summary-model.text_77d22441ed"))
        if (error instanceof TypeError) throw new Error($t("services.official-links.summary-model.text_13a0438686"))
        throw error
      }
    },
  }
}
