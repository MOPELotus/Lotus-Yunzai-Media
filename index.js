import { BilibiliMedia } from "./apps/bilibili.js"
import { DouyinMedia } from "./apps/douyin.js"
import { MusicMedia, renderPartnerReport, runPartnerTask } from "./apps/music.js"
import { createMcWikiCommand } from "./services/mcwiki/command.js"
import { createPartnerSchedule } from "./services/music/partner-schedule.js"
import { createSubscriptionModule } from "./services/subscriptions/module.js"
import { resumeTuneWeaveOnStart } from "./services/tuneweave/startup.js"

export const apps = { BilibiliMedia, DouyinMedia, MusicMedia }
export default { commands: {} }

export async function createModule(services) {
  const subscriptions = await createSubscriptionModule(services)
  const stopTuneWeave = resumeTuneWeaveOnStart(services)
  const stopPartner = await createPartnerSchedule(services, { execute:runPartnerTask, render:renderPartnerReport })
  const mcwiki = createMcWikiCommand({ signal: services.signal })
  return {
    ...subscriptions,
    async dispose() {
      await Promise.all([subscriptions.dispose(), stopPartner?.(), stopTuneWeave?.()])
    },
    commands: { ...subscriptions.commands, "#mcwiki": mcwiki },
    fallback(message, context) {
      if (message.startsWith("#mcwiki") && /^\S/u.test(message.slice(7))) return mcwiki(message.slice(7))
      return subscriptions.fallback(message, context)
    },
  }
}
