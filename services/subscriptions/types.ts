import type { connectStorage } from "@lotus-yunzai/storage"
import type { MessageFallbackContext } from "../../../../lib/commands.ts"

export type SubscriptionPlatform = "bilibili" | "weibo"
export type SubscriptionRedis = Pick<Awaited<ReturnType<typeof connectStorage>>, "get" | "mGet" | "set" | "eval" | "pTTL">
export type GetSubscriptionRedis = () => SubscriptionRedis | undefined
export type LockSubscriptionFile = (path: string, subject: string) => Promise<{ close(): void }>
export type SubscriptionContext = Pick<MessageFallbackContext,
  "message_type" | "user_id" | "group_id" | "self_id" | "adapter" | "isMaster" | "isDelegated" | "isBotMaster">

export interface DynamicActivity {
  area?: string
  openedAt?: number
  roomUrl?: string
  viewers?: string
  views?: string
  bullets?: string
  likes?: string
  comments?: string
  shares?: string
}

export interface DynamicPost {
  id: string
  uid: string
  author: string
  createdAt: number
  type: string
  title?: string
  content: string
  url: string
  images: string[]
  cover?: string
  avatar?: string
  forwarded?: DynamicPost
  activity?: DynamicActivity
}

export interface SubscriptionProfile {
  uid: string
  name: string
  gender?: string
  level?: number | string
  verification?: string
  verificationFailure?: string
  followers?: string
  following?: string
  summary?: string
  live?: { roomId: string; title?: string; status?: string; viewers?: string }
}

export interface SubscriptionProvider {
  readonly id: SubscriptionPlatform
  readonly label: string
  readonly typeNames: Readonly<Record<string, string>>
  fetchPosts(uid: string, options?: { signal?: AbortSignal; oldest?: number }): Promise<DynamicPost[]>
  profile(uid: string, options?: { signal?: AbortSignal; allowUnverified?: boolean }): Promise<SubscriptionProfile | undefined>
  search?(keyword: string, options?: { signal?: AbortSignal }): Promise<SubscriptionProfile[]>
}

export type SubscriptionProviders = Partial<Record<SubscriptionPlatform, SubscriptionProvider>>
