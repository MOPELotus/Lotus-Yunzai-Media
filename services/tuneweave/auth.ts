import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
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
    if (signal?.aborted) throw new Error($t("services.tuneweave.auth.text_f6c21b7575"))
  }
  const checkBinding = (value: TuneWeaveQrProfile | undefined | null) => {
    if ((value?.platform != null && value.platform !== platform) || (value?.account != null && value.account !== alias)) {
      throw new Error($t("services.tuneweave.auth.text_941160bb52"))
    }
  }
  const verified = (value: TuneWeaveQrProfile | undefined | null): value is VerifiedQrProfile => {
    const uid = value?.user_id
    return value?.authenticated === true && (typeof uid === "string"
      ? uid.length > 0 && uid.trim() === uid && !/[\u0000-\u001f\u007f]/u.test(uid)
      : typeof uid === "number" && Number.isSafeInteger(uid) && uid > 0)
  }
  checkCancelled()
  checkBinding(profile)
  if (!verified(profile)) {
    profile = await tuneweave.request(`/v1/account?${new URLSearchParams({ platform, account: alias })}`, { signal, redirect: "error" })
  }
  checkCancelled()
  checkBinding(profile)
  if (!verified(profile)) throw new Error($t("services.tuneweave.auth.text_73070f5f12"))
  return profile
}
