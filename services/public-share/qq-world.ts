import type { MessageFallbackContext } from "../../../../lib/commands.ts"
import { loadGlobalConfig } from "../../core/config/global.ts"
import { buildMediaMessageText, isMediaCommandText } from "../media/message.ts"
import { legacyGeneralShareSettings } from "./settings.ts"

const feature = "[media] QQ 小世界链接"
const short = /(?<=^|[\s\p{Ps}\p{Pi}"'：，、；])(?:https?:\/\/)?s\.xsj\.qq\.com\/([A-Za-z0-9]{3,32})\/?(?=$|[?\s\p{Pe}\p{Pf}。，、！？、;])/iu

function identify(message: string, context: MessageFallbackContext) {
  if (context.isDelegated || (context.message_type !== "group" && context.message_type !== "private") || isMediaCommandText(message)) return
  const contents = buildMediaMessageText({ ...context, msg: message }).replaceAll("\\/", "/")
  return short.exec(contents)?.[1]
}

async function defaultSettings() {
  return legacyGeneralShareSettings((await loadGlobalConfig()).tools)
}

export function createQqWorldNotice({ signal, settings = defaultSettings }:
  { readonly signal?: AbortSignal; readonly settings?: typeof defaultSettings } = {}) {
  return {
    features(context: MessageFallbackContext) {
      return !signal?.aborted && identify(context.normalizedMessage, context) ? [feature] : []
    },
    async fallback(message: string, context: MessageFallbackContext) {
      const code = identify(message, context)
      if (!code || signal?.aborted) return
      const connection = context.message_type === "private" ? context.privateCredentialSignal : context.groupActivitySignal
      if (connection?.aborted || (context.message_type === "private" && !connection)) return
      const options = await settings().catch(() => undefined)
      if (signal?.aborted || connection?.aborted || !options?.enable || (context.message_type === "private" && !options.private)) return
      return "QQ 小世界已停止公开查看。\nhttps://s.xsj.qq.com/" + code
    },
  }
}
