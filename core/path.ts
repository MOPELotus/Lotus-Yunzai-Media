import path from "node:path"
import { fileURLToPath } from "node:url"

export const rootPath = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)))
export const configPath = path.join(rootPath, "config")
export const dataPath = path.join(rootPath, "data")
export const resourcesPath = path.join(rootPath, "data", "passport", "resources")

export function resolveRoot(...segments: string[]) {
  return path.join(rootPath, ...segments)
}

export function resolveData(...segments: string[]) {
  return path.join(dataPath, ...segments)
}

export function resolveConfig(...segments: string[]) {
  return path.join(configPath, ...segments)
}
