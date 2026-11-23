import type { CommandModule } from "../../lib/commands.ts"
import { createAcfunCommands } from "./services/acfun/command.ts"
import { createPipixiaCommands } from "./services/pipixia/command.ts"
import { createBilibiliLogin } from "./services/bilibili/login-command.ts"
import { createBilibiliVideoCommands } from "./services/bilibili/video-command.ts"
import { createDouyinCommands } from "./services/douyin/command.ts"
import { createMusicCommands } from "./services/music/command.ts"
import { createMcWikiCommand } from "./services/mcwiki/command.ts"
import { createPartnerSchedule } from "./services/music/partner-schedule.ts"
import { createSubscriptionModule } from "./services/subscriptions/module.ts"
import { startMediaMaintenance } from "./services/tuneweave/startup.ts"
import { createMediaEnvironment } from "./services/tools/command.ts"
import { createOfficialVideoCommands } from "./services/official-video/index.ts"
import { createMiyoushePostCommands } from "./services/official-video/post-command.ts"
import { createPublicShareCommands } from "./services/public-share/command.ts"
import { createOfficialLinkPreview } from "./services/official-links/command.ts"

type MediaServices = Parameters<typeof createSubscriptionModule>[0] &
  Parameters<typeof createPartnerSchedule>[0] & Parameters<typeof startMediaMaintenance>[0] & Parameters<typeof createOfficialVideoCommands>[0] &
  { readonly officialLinks?: Omit<Parameters<typeof createOfficialLinkPreview>[0], "signal"> }

type MediaCommandModule = Omit<CommandModule, "name"> & { dispose(): Promise<void> }

export default { commands: {} } satisfies Pick<CommandModule, "commands">

export async function createModule(services: MediaServices): Promise<MediaCommandModule> {
  const biliVideo = createBilibiliVideoCommands(services)
  const subscriptions = await createSubscriptionModule({ ...services, quotedBilibiliAuthor: biliVideo.quotedAuthor })
  const maintenance = startMediaMaintenance(services)
  const music = createMusicCommands(services)
  const stopPartner = await createPartnerSchedule(services, {
    execute: music.executePartner,
    render: music.renderPartner,
    waitForMaintenance: maintenance?.waitForFirstRound,
  })
  const mcwiki = createMcWikiCommand({ signal: services.signal })
  const douyin = createDouyinCommands(services)
  const acfun = createAcfunCommands(services)
  const pipixia = createPipixiaCommands(services)
  const biliLogin = createBilibiliLogin(services)
  const environment = createMediaEnvironment(services)
  const officialVideo = createOfficialVideoCommands(services)
  const miyoushePost = createMiyoushePostCommands(services)
  const publicShare = createPublicShareCommands(services)
  const officialLinks = createOfficialLinkPreview({ ...services.officialLinks, signal: services.signal })
  return {
    ...subscriptions,
    async dispose() {
      await Promise.all([subscriptions.dispose(), stopPartner?.(), maintenance?.dispose(), douyin.dispose(), acfun.dispose(), pipixia.dispose(), biliVideo.dispose(), music.dispose(),
        officialVideo.dispose(), miyoushePost.dispose(), publicShare.dispose()])
    },
    commands: { ...subscriptions.commands, "#mcwiki": async argument => await mcwiki(argument) ?? [] },
    fallbackFeatures(context) {
      const subscriptionFeatures = subscriptions.features(context)
      if (subscriptionFeatures.length) return subscriptionFeatures
      if (officialVideo.matches(context.normalizedMessage)) return ["[media] 米游社官号视频"]
      if (context.normalizedMessage === biliLogin.command || environment.matches(context.normalizedMessage)) return ["[media] B 站解析"]
      const features = biliVideo.features(context)
      if (features.length) return features
      const acfunFeatures = acfun.features(context)
      if (acfunFeatures.length) return acfunFeatures
      const publicShareFeatures = publicShare.features(context)
      if (publicShareFeatures.length) return publicShareFeatures
      const songFeatures = music.features(context)
      if (songFeatures.length) return songFeatures
      const articleFeatures = miyoushePost.features(context)
      if (articleFeatures.length) return articleFeatures
      const pipixiaFeatures = pipixia.features(context)
      if (pipixiaFeatures.length) return pipixiaFeatures
      const shortVideoFeatures = douyin.features(context)
      return shortVideoFeatures.length ? shortVideoFeatures : officialLinks.features(context)
    },
    async fallback(message, context) {
      if (officialVideo.matches(context.normalizedMessage)) return officialVideo.fallback(context.normalizedMessage, context)
      if (message.startsWith("#mcwiki") && /^\S/u.test(message.slice(7))) return mcwiki(message.slice(7))
      if (message === biliLogin.command) return biliLogin.fallback(message, context)
      if (environment.matches(message)) return environment.fallback(message, context)
      return await subscriptions.fallback(message, context) ?? await biliVideo.fallback(message, context) ??
        await acfun.fallback(message, context) ?? await publicShare.fallback(message, context) ?? await music.fallback(message, context) ??
        await miyoushePost.fallback(message, context) ?? await pipixia.fallback(message, context) ??
        await douyin.fallback(message, context) ?? officialLinks.fallback(message, context)
    },
  }
}
