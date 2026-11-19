import { BilibiliMedia } from "./apps/bilibili.js"
import { DouyinMedia } from "./apps/douyin.js"
import { MusicMedia } from "./apps/music.js"
import { createMcWikiCommand } from "./services/mcwiki/command.js"
import { createSubscriptionModule } from "./services/subscriptions/module.js"

export const apps = { BilibiliMedia, DouyinMedia, MusicMedia }
export default { commands: {} }

export async function createModule(services) {
  const subscriptions = await createSubscriptionModule(services)
  const mcwiki = createMcWikiCommand({ signal: services.signal })
  return {
    ...subscriptions,
    commands: { ...subscriptions.commands, "#mcwiki": mcwiki },
    fallback(message, context) {
      if (message.startsWith("#mcwiki") && /^\S/u.test(message.slice(7))) return mcwiki(message.slice(7))
      return subscriptions.fallback(message, context)
    },
  }
}
