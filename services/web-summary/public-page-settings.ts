import { isDeepStrictEqual } from "node:util"
import { Document, isAlias, isMap, isNode, isSeq, parseDocument, type Node } from "yaml"
import { readLotusGlobalConfig } from "../../../../lib/lotus-global-config.ts"
import { GlobalConfigWriteError, updateLotusGlobalConfig } from "../../../../lib/lotus-global-config-write.ts"
import { insertSourcePairs, replaceSourceScalar, sourceMappingPair, type Pair, type SourceEdit } from "../../../../lib/yaml-source-edits.ts"
import { parsePublicPageDenyHosts, parsePublicPageDenyNetworks } from "./public-page-network.ts"

export const publicPageExclusions = {
  deny_hosts: parsePublicPageDenyHosts,
  deny_networks: parsePublicPageDenyNetworks,
} as const

export type PublicPageExclusion = keyof typeof publicPageExclusions
type Patch = Partial<Record<PublicPageExclusion, string[]>>

function mapping(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
}

export async function readPublicPageExclusions(root: URL): Promise<Patch | undefined> {
  const source = mapping((await readLotusGlobalConfig(root)).web_summary)
  if (!source) return
  const result: Patch = {}
  for (const field of Object.keys(publicPageExclusions) as PublicPageExclusion[]) {
    if (source[field] === undefined) result[field] = []
    else {
      const values = publicPageExclusions[field](source[field])
      if (values) result[field] = values
    }
  }
  return result
}

function replaceList(text: string, source: Node, values: readonly string[]): SourceEdit {
  if (!isSeq(source)) return replaceSourceScalar(text, source, JSON.stringify(values))
  if (!source.range || source.anchor || source.items.some(item => !isNode(item) || isAlias(item) || ("anchor" in item && item.anchor))) {
    throw new GlobalConfigWriteError("config")
  }
  const node = source.clone()
  const yaml = new Document()
  const available = node.items.map(item => ({ item, used: false }))
  node.items = values.map(value => {
    const match = available.find(entry => !entry.used && isNode(entry.item) && "value" in entry.item && entry.item.value === value)
    if (!match) return yaml.createNode(value)
    match.used = true
    return match.item
  })
  yaml.set("list", node)
  const rendered = yaml.toString({ lineWidth: 0 })
  const replacement = parseDocument(rendered).get("list", true)
  if (!isSeq(replacement) || !replacement.range) throw new GlobalConfigWriteError("config")
  const [start, end] = source.range
  const [first, last] = replacement.range
  const offset = start - text.lastIndexOf("\n", start - 1) - 1
  const indent = first - rendered.lastIndexOf("\n", first - 1) - 1
  const eol = /\r?\n/u.exec(text)?.[0] ?? "\n"
  let value = rendered.slice(first, last).split("\n").map((line, index) =>
    index === 0 || !line ? line : " ".repeat(offset) + line.slice(indent)).join(eol)
  if (text.slice(start, end).endsWith("\n") && !value.endsWith("\n")) value += eol
  return { start, end, value }
}

export function savePublicPageExclusions(root: URL, patch: Patch) {
  return updateLotusGlobalConfig(root, {
    canWrite: () => true,
    prepare(text, local, effective) {
      const current = mapping(effective.web_summary)
      if (effective.web_summary !== undefined && !current) throw new GlobalConfigWriteError("config")
      const changes = Object.entries(patch).filter(([field, value]) => !isDeepStrictEqual(current?.[field], value))
      if (!changes.length) return { value: undefined }

      const document = parseDocument(text, { strict: true, merge: true, uniqueKeys: true, keepSourceTokens: true })
      if (document.errors.length || (document.contents && !isMap(document.contents))) throw new GlobalConfigWriteError("config")
      const rootMap = document.contents ?? undefined
      const section = rootMap?.get("web_summary", true)
      const desired = { ...current, ...patch }
      const additions: Pair[] = []
      const edits: SourceEdit[] = []
      if (section === undefined) edits.push(insertSourcePairs(text, rootMap, [sourceMappingPair("web_summary", desired)]))
      else if (isMap(section)) {
        for (const [field, value] of changes) {
          const source = section.get(field, true)
          if (isNode(source)) edits.push(replaceList(text, source, value))
          else {
            const flow = JSON.stringify(value)
            additions.push({ key: field, flow, block: [`${field}: ${flow}`] })
          }
        }
        if (additions.length) edits.push(insertSourcePairs(text, section, additions))
      } else throw new GlobalConfigWriteError("config")

      const yaml = edits.sort((a, b) => b.start - a.start || b.end - a.end)
        .reduce((content, edit) => content.slice(0, edit.start) + edit.value + content.slice(edit.end), text)
      if (!isDeepStrictEqual(Bun.YAML.parse(yaml), { ...local, web_summary: desired })) throw new GlobalConfigWriteError("config")
      return { yaml, value: undefined }
    },
  })
}
