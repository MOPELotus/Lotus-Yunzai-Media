import { expect, test } from "bun:test"
import type { MessageFallbackContext } from "../../../lib/commands.ts"
import { createQqWorldNotice } from "../services/public-share/qq-world.ts"

const link = "https://s.xsj.qq.com/NatO1nlk"
const context = (normalizedMessage: string, extra: Partial<MessageFallbackContext> = {}) => ({
  normalizedMessage, message_type: "group", ...extra,
}) as MessageFallbackContext

test("QQ 小世界旧短链提示停止公开查看，保持历史私聊限制和精确域名", async () => {
  let reads = 0
  let options = { enable: true, private: false }
  const notice = createQqWorldNotice({ settings: async () => { reads++; return options } })
  for (const wrong of [
    "https://v.qq.com/x/cover/123", "https://s.xsj.qq.com.example/NatO1nlk",
    "https://example.test/s.xsj.qq.com/NatO1nlk", link + "/unknown",
  ]) {
    expect(notice.features(context(wrong))).toEqual([])
    expect(await notice.fallback(wrong, context(wrong))).toBeUndefined()
  }
  expect(await notice.fallback(link, context(link, { isDelegated: true }))).toBeUndefined()
  expect(reads).toBe(0)
  const shared = "分享：" + link + "?from=chat"
  expect(notice.features(context(shared))).toEqual(["[media] QQ 小世界链接"])
  expect(await notice.fallback(shared, context(shared))).toBe("QQ 小世界已停止公开查看。\n" + link)
  const friend = context(shared, { message_type: "private", privateCredentialSignal: new AbortController().signal })
  expect(await notice.fallback(shared, friend)).toBeUndefined()
  options = { enable: true, private: true }
  expect(await notice.fallback(shared, friend)).toContain(link)
  options = { enable: false, private: true }
  expect(await notice.fallback(link, context(link))).toBeUndefined()
})
