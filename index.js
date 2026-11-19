import { LotusBilibili } from "./apps/bilibili.js"
import { LotusDouyin } from "./apps/douyin.js"
import { LotusMusic } from "./apps/music.js"

export const apps = { LotusBilibili, LotusDouyin, LotusMusic }
export default { commands: {} }

export { createSubscriptionModule as createModule } from "./services/subscriptions/module.js"
