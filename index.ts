import type { CommandModule } from "../../lib/commands.ts"
import { createAcfunCommands } from "./services/acfun/command.ts"
import { createJikeCommands } from "./services/jike/command.ts"
import { createKuaishouCommands } from "./services/kuaishou/command.ts"
import { createPipixiaCommands } from "./services/pipixia/command.ts"
import { createBilibiliLogin } from "./services/bilibili/login-command.ts"
import { biliFeatureNames, createBilibiliVideoCommands } from "./services/bilibili/video-command.ts"
import { createBiliPgcPreview } from "./services/bilibili/pgc.ts"
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
import { createWeixinChannelsPreview } from "./services/weixin-channels/preview.ts"
import { createOfficialLinkPreview } from "./services/official-links/command.ts"
import { createWebSummary } from "./services/web-summary/command.ts"

type MediaServices = Parameters<typeof createSubscriptionModule>[0] &
  Parameters<typeof createPartnerSchedule>[0] & Parameters<typeof startMediaMaintenance>[0] & Parameters<typeof createOfficialVideoCommands>[0] &
  {
    readonly officialLinks?: Omit<Parameters<typeof createOfficialLinkPreview>[0], "signal">
    readonly biliVideo?: Pick<Parameters<typeof createBilibiliVideoCommands>[0], "fetch" | "settings">
    readonly biliPgc?: Omit<Parameters<typeof createBiliPgcPreview>[0], "signal">
  }

type MediaCommandModule = Omit<CommandModule, "name"> & { dispose(): Promise<void> }

export default { commands: {} } satisfies Pick<CommandModule, "commands">

export async function createModule(services: MediaServices): Promise<MediaCommandModule> {
  const biliPgc = createBiliPgcPreview({ ...services.biliPgc, signal: services.signal })
  const biliVideo = createBilibiliVideoCommands({ ...services, ...services.biliVideo, resolvedPgc: biliPgc.resolved })
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
  const kuaishou = createKuaishouCommands(services)
  const jike = createJikeCommands(services)
  const biliLogin = createBilibiliLogin(services)
  const environment = createMediaEnvironment(services)
  const officialVideo = createOfficialVideoCommands(services)
  const miyoushePost = createMiyoushePostCommands(services)
  const publicShare = createPublicShareCommands(services)
  const weixinChannels = createWeixinChannelsPreview({ signal: services.signal })
  const officialLinks = createOfficialLinkPreview({ ...services.officialLinks, signal: services.signal })
  const webSummary = createWebSummary({ ...services.officialLinks, signal: services.signal })
  return {
    ...subscriptions,
    async dispose() {
      await Promise.all([subscriptions.dispose(), stopPartner?.(), maintenance?.dispose(), douyin.dispose(), acfun.dispose(), pipixia.dispose(), kuaishou.dispose(), biliVideo.dispose(), music.dispose(),
        officialVideo.dispose(), miyoushePost.dispose(), publicShare.dispose()])
    },
    commands: { ...subscriptions.commands, "#mcwiki": async argument => await mcwiki(argument) ?? [] },
    fallbackFeatures(context) {
      const subscriptionFeatures = subscriptions.features(context)
      if (subscriptionFeatures.length) return subscriptionFeatures
      if (officialVideo.matches(context.normalizedMessage)) return ["[media] 米游社官号视频"]
      if (biliLogin.matches(context.normalizedMessage) || environment.matches(context.normalizedMessage)) return biliFeatureNames
      if (biliPgc.matches(context.normalizedMessage, context)) return biliFeatureNames
      const features = biliVideo.features(context)
      if (features.length) return features
      const acfunFeatures = acfun.features(context)
      if (acfunFeatures.length) return acfunFeatures
      const publicShareFeatures = publicShare.features(context)
      if (publicShareFeatures.length) return publicShareFeatures
      const weixinFeatures = weixinChannels.features(context)
      if (weixinFeatures.length) return weixinFeatures
      const songFeatures = music.features(context)
      if (songFeatures.length) return songFeatures
      const articleFeatures = miyoushePost.features(context)
      if (articleFeatures.length) return articleFeatures
      const pipixiaFeatures = pipixia.features(context)
      if (pipixiaFeatures.length) return pipixiaFeatures
      const kuaishouFeatures = kuaishou.features(context)
      if (kuaishouFeatures.length) return kuaishouFeatures
      const jikeFeatures = jike.features(context)
      if (jikeFeatures.length) return jikeFeatures
      const shortVideoFeatures = douyin.features(context)
      if (shortVideoFeatures.length) return shortVideoFeatures
      const summaryFeatures = webSummary.features(context)
      return summaryFeatures.length ? summaryFeatures : officialLinks.features(context)
    },
    async fallback(message, context) {
      if (officialVideo.matches(context.normalizedMessage)) return officialVideo.fallback(context.normalizedMessage, context)
      if (message.startsWith("#mcwiki") && /^\S/u.test(message.slice(7))) return mcwiki(message.slice(7))
      if (biliLogin.matches(message)) return biliLogin.fallback(message, context)
      if (environment.matches(message)) return environment.fallback(message, context)
      if (biliPgc.matches(message, context)) return biliPgc.fallback(message, context)
      return await subscriptions.fallback(message, context) ?? await biliVideo.fallback(message, context) ??
        await acfun.fallback(message, context) ?? await publicShare.fallback(message, context) ?? await weixinChannels.fallback(message, context) ?? await music.fallback(message, context) ??
        await miyoushePost.fallback(message, context) ?? await pipixia.fallback(message, context) ?? await kuaishou.fallback(message, context) ?? await jike.fallback(message, context) ??
        await douyin.fallback(message, context) ?? await webSummary.fallback(message, context) ?? officialLinks.fallback(message, context)
    },
  }
}
