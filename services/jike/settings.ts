import { createPublicShareSettings } from "../public-share/settings.ts"

export const jikeFields = [["enable", "解析即刻链接"], ["private", "即刻私聊自动解析"]] as const

export function createJikeSettings(directory?: string, root?: string) {
  return createPublicShareSettings("jike", "即刻", directory, root)
}
