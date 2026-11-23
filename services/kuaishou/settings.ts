import { createPublicShareSettings } from "../public-share/settings.ts"

export const kuaishouFields = [["enable", "解析快手链接"], ["private", "快手私聊自动解析"]] as const

export function createKuaishouSettings(directory?: string, root?: string) {
  return createPublicShareSettings("kuaishou", "快手", directory, root)
}
