import { BilibiliMedia } from "./apps/bilibili.js"
import { createBilibiliLogin } from "./services/bilibili/login-command.ts"
import { createBilibiliVideoCommands } from "./services/bilibili/video-command.ts"
import { createDouyinCommands } from "./services/douyin/command.ts"
import { MusicMedia, renderPartnerReport, runPartnerTask } from "./apps/music.js"
import { createMcWikiCommand } from "./services/mcwiki/command.js"
import { createPartnerSchedule } from "./services/music/partner-schedule.js"
import { createSubscriptionModule } from "./services/subscriptions/module.js"
import { resumeTuneWeaveOnStart } from "./services/tuneweave/startup.js"

export const apps = { BilibiliMedia, MusicMedia }
export default { commands: {} }

export async function createModule(services) {
  const subscriptions = await createSubscriptionModule(services)
  const stopTuneWeave = resumeTuneWeaveOnStart(services)
  const stopPartner = await createPartnerSchedule(services, { execute:runPartnerTask, render:renderPartnerReport })
  const mcwiki = createMcWikiCommand({ signal: services.signal })
  const douyin = createDouyinCommands(services)
  const biliLogin = createBilibiliLogin(services)
  const biliVideo = createBilibiliVideoCommands(services)
  return {
    ...subscriptions,
    async dispose() {
      await Promise.all([subscriptions.dispose(), stopPartner?.(), stopTuneWeave?.(), douyin.dispose(), biliVideo.dispose()])
    },
    commands: { ...subscriptions.commands, "#mcwiki": mcwiki },
    fallbackFeatures(context) {
      if (context.normalizedMessage === biliLogin.command) return ["[media] B 站解析"]
      const features = biliVideo.features(context)
      if (features.length) return features
      return douyin.features(context)
    },
    async fallback(message, context) {
      if (message.startsWith("#mcwiki") && /^\S/u.test(message.slice(7))) return mcwiki(message.slice(7))
      if (message === biliLogin.command) return biliLogin.fallback(message, context)
      return await subscriptions.fallback(message, context) ?? await biliVideo.fallback(message, context) ?? douyin.fallback(message, context)
    },
  }
}
