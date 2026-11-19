import { BilibiliMedia } from "./apps/bilibili.js"
import { DouyinMedia } from "./apps/douyin.js"
import { MusicMedia } from "./apps/music.js"

export const apps = { BilibiliMedia, DouyinMedia, MusicMedia }
export default { commands: {} }

export { createSubscriptionModule as createModule } from "./services/subscriptions/module.js"
