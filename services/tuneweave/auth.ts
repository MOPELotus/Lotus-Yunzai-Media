import type { TuneWeaveRequestOptions } from "./service.ts"

export interface TuneWeaveQrProfile {
  platform?: string
  account?: string
  authenticated?: boolean
  user_id?: string | number
  nickname?: string
}

type VerifiedQrProfile = TuneWeaveQrProfile & { authenticated: true; user_id: string | number }

interface QrProfileRequest {
  request(route: string, options: Pick<TuneWeaveRequestOptions, "signal" | "redirect">): Promise<TuneWeaveQrProfile | null | undefined>
}

interface QrProfileOptions {
  platform: string
  alias: string
  profile?: TuneWeaveQrProfile | null
  signal?: AbortSignal
}

// QR confirmations can contain a valid session without its account identity.
// Login uses credential_mode=both, so the same alias can resolve that identity.
export async function resolveQrProfile(tuneweave: QrProfileRequest, { platform, alias, profile, signal }: QrProfileOptions) {
  const checkCancelled = () => {
    if (signal?.aborted) throw new Error("扫码登录已取消")
  }
  const checkBinding = (value: TuneWeaveQrProfile | undefined | null) => {
    if (value?.platform && value.platform !== platform || value?.account && value.account !== alias) throw new Error("平台登录账号不匹配，请重新登录")
  }
  const verified = (value: TuneWeaveQrProfile | undefined | null): value is VerifiedQrProfile =>
    Boolean(value?.authenticated && value.user_id)
  checkCancelled()
  checkBinding(profile)
  if (!verified(profile)) {
    profile = await tuneweave.request(`/v1/account?${new URLSearchParams({ platform, account: alias })}`, { signal, redirect: "error" })
  }
  checkCancelled()
  checkBinding(profile)
  if (!verified(profile)) throw new Error("平台登录身份未核验，请重新登录")
  return profile
}
