import type { CommandModule } from "../../lib/commands.ts"
import { createBilibiliLogin } from "./services/bilibili/login-command.ts"
import { createBilibiliVideoCommands } from "./services/bilibili/video-command.ts"
import { createDouyinCommands } from "./services/douyin/command.ts"
import { createMusicCommands } from "./services/music/command.ts"
import { createMcWikiCommand } from "./services/mcwiki/command.ts"
import { createPartnerSchedule } from "./services/music/partner-schedule.ts"
import { createSubscriptionModule } from "./services/subscriptions/module.ts"
import { resumeTuneWeaveOnStart } from "./services/tuneweave/startup.ts"
import { createMediaEnvironment } from "./services/tools/command.ts"

type MediaServices = Parameters<typeof createSubscriptionModule>[0] &
  Parameters<typeof createPartnerSchedule>[0] & Parameters<typeof resumeTuneWeaveOnStart>[0]

type MediaCommandModule = Omit<CommandModule, "name"> & { dispose(): Promise<void> }

export default { commands: {} } satisfies Pick<CommandModule, "commands">

export async function createModule(services: MediaServices): Promise<MediaCommandModule> {
  const subscriptions = await createSubscriptionModule(services)
  const stopTuneWeave = resumeTuneWeaveOnStart(services)
  const music = createMusicCommands(services)
  const stopPartner = await createPartnerSchedule(services, { execute:music.executePartner, render:music.renderPartner })
  const mcwiki = createMcWikiCommand({ signal: services.signal })
  const douyin = createDouyinCommands(services)
  const biliLogin = createBilibiliLogin(services)
  const biliVideo = createBilibiliVideoCommands(services)
  const environment = createMediaEnvironment(services)
  return {
    ...subscriptions,
    async dispose() {
      await Promise.all([subscriptions.dispose(), stopPartner?.(), stopTuneWeave?.(), douyin.dispose(), biliVideo.dispose(), music.dispose()])
    },
    commands: { ...subscriptions.commands, "#mcwiki": async argument => await mcwiki(argument) ?? [] },
    fallbackFeatures(context) {
      if (context.normalizedMessage === biliLogin.command || context.normalizedMessage === environment.command) return ["[media] B 站解析"]
      const features = biliVideo.features(context)
      if (features.length) return features
      const songFeatures = music.features(context)
      return songFeatures.length ? songFeatures : douyin.features(context)
    },
    async fallback(message, context) {
      if (message.startsWith("#mcwiki") && /^\S/u.test(message.slice(7))) return mcwiki(message.slice(7))
      if (message === biliLogin.command) return biliLogin.fallback(message, context)
      if (message === environment.command) return environment.fallback(message, context)
      return await subscriptions.fallback(message, context) ?? await biliVideo.fallback(message, context) ??
        await music.fallback(message, context) ?? douyin.fallback(message, context)
    },
  }
}
