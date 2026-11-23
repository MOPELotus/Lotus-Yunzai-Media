import { createPublicShareSettings, type PublicShareSettings } from "../public-share/settings.ts"

export const pipixiaFields = [["enable", "解析皮皮虾链接"], ["private", "私聊自动解析"]] as const
export type PipixiaSettings = PublicShareSettings

export function createPipixiaSettings(directory?: string, root?: string) {
  return createPublicShareSettings("pipixia", "皮皮虾", directory, root)
}
