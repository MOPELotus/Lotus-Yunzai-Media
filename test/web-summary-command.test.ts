import { expect, test } from "bun:test"
import { sendCommandReply, type MessageFallbackContext } from "../../../lib/commands.ts"
import { createWebSummary } from "../services/web-summary/command.ts"

const url = "https://arxiv.org/abs/1706.03762v1"
const event = (normalizedMessage: string, extra: Partial<MessageFallbackContext> = {}) => ({
  normalizedMessage, msg: normalizedMessage, message_type: "group", user_id: 100,
  group_id: 200, self_id: 300, async reply() { return true }, ...extra,
}) as MessageFallbackContext
const article = () => new Response(`<feed><entry><id>${url}</id><title>论文题目</title>
  <author><name>作者</name></author><summary>原始论文摘要。</summary></entry></feed>`,
{ headers: { "Content-Type": "application/atom+xml" } })
const links = { youtube: true, youtubeMusic: true, telegram: true, v2ex: true, x: true, articles: true,
  private: false, trustedTelegramUsers: [], trustedXUsers: [] }
const summaryConfig = { summaryEnabled: true, summaryMode: "general" as const,
  summaryBaseUrl: "http://127.0.0.1:1234", summaryModel: "fixture", summaryApiKeyConfigured: true }

test("支持的原文核验后才能请求摘要，摘要和原链接走真正的合并发送分支", async () => {
  const calls: string[] = []
  const command = createWebSummary({ settings: async () => links, fetcher: async input => {
    calls.push(input.href)
    return article()
  }, model: {
    settings: async () => summaryConfig,
    summarize: async payload => {
      expect(payload).toEqual({ title: "论文题目", text: "原始论文摘要。" })
      calls.push("model")
      return "验证后的模型摘要"
    },
  } })
  const input = "#总结一下" + url
  expect(command.features(event(input))).toEqual(["[media] 网页总结"])
  const result = await command.fallback(input, event(input))
  const forward: unknown[] = []
  await sendCommandReply({ reply: async () => { throw new Error("应走转发") }, forward: async nodes => {
    forward.push(...nodes)
    return true
  } }, result!)
  expect(forward).toEqual(["《论文题目》 · 原文 7 字 · 预计阅读 1 分钟", "作者", "验证后的模型摘要", url])
  expect(calls).toEqual(["https://export.arxiv.org/api/query?id_list=1706.03762v1", "model"])
  expect(await command.fallback(input, event(input, { message_type: "private" }))).toEqual([])
  expect(await command.fallback(input, event(input, { groupActivitySignal: AbortSignal.abort() }))).toEqual([])
  expect(await command.fallback("#总结一下 http://127.0.0.1:90/read", event(input))).toBeUndefined()
  expect(calls).toHaveLength(2)
})

test("模型失败只展示核验过的原文，读取错编号时直接保留链接", async () => {
  let response = article()
  let called = 0
  const command = createWebSummary({ settings: async () => links, fetcher: async () => response, render: async () => {
    throw new Error("文字回退")
  }, model: { settings: async () => summaryConfig, summarize: async () => { called++; throw new Error("模型超时") } } })
  expect(await command.fallback(url, event(url))).toBe(`论文题目\n作者\n原始论文摘要。\n${url}`)
  response = new Response("other", { headers: { "Content-Type": "text/html" } })
  expect(await command.fallback(url, event(url))).toBe(`暂无法读取公开原文。\n${url}`)
  expect(called).toBe(1)
})
