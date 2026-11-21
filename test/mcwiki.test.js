import { expect, test } from "bun:test"
import { mcWikiTitle, readMcWikiArticle } from "../services/mcwiki/article.ts"
import { createMcWikiCommand } from "../services/mcwiki/command.ts"

const url = "https://zh.minecraft.wiki/w/%E5%90%88%E6%88%90"
const html = `
  <div class="mw-parser-output">
    <style>p { background: url(file:///fixture.css) }</style>
    <p>首段包含<a href="https://third-party.invalid/">条目链接</a>和<sup class="reference">[2]</sup>说明。</p>
    <p><script>fixtureOnly()</script><span hidden>隐私示例</span>次段正文。</p>
    <div class="infobox"><div class="tabbertab" data-title="基岩版">
      <table class="infobox-rows"><tr><th>分类</th><td>方块</td></tr></table>
    </div></div>
    <img src="https://third-party.invalid/fixture.png">
  </div>`
function page(overrides = {}) {
  return { query: { pages: [{ pageid: 8, lastrevid: 22, title: "合成", contentmodel: "wikitext", fullurl: url, ...overrides }] } }
}
function parsed(overrides = {}) {
  return { parse: { pageid: 8, revid: 22, title: "合成", text: html, ...overrides } }
}
function fixture(data, lead) {
  const calls = []
  return { calls, async transport(target, options) {
    calls.push({ target, options })
    return Response.json(target.searchParams.get("action") === "query" ? data : lead)
  } }
}

test("一手 API 查询固定同一修订，预览只投影导语和信息表文字", async () => {
  const { calls, transport } = fixture(page(), parsed())
  const result = await readMcWikiArticle("別名", { transport })
  expect(calls.map(call => [call.target.origin, call.target.pathname])).toEqual([
    ["https://zh.minecraft.wiki", "/api.php"], ["https://zh.minecraft.wiki", "/api.php"],
  ])
  expect(Object.fromEntries(calls[0].target.searchParams)).toMatchObject({ action: "query", titles: "別名", formatversion: "2", redirects: "1" })
  expect(Object.fromEntries(calls[1].target.searchParams)).toMatchObject({ action: "parse", oldid: "22", section: "0", prop: "text|revid" })
  for (const { options } of calls) {
    expect(options).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" })
    expect(new Headers(options.headers).has("Cookie")).toBe(false)
    expect(new Headers(options.headers).has("Authorization")).toBe(false)
  }
  expect(result).toEqual({ status: "article", url, article: {
    title: "合成", revisionId: 22, revisionUrl: url + "?oldid=22", license: "https://creativecommons.org/licenses/by-nc-sa/3.0/",
    paragraphs: ["首段包含条目链接和说明。", "次段正文。"], details: [{ label: "基岩版 · 分类", value: "方块" }],
  } })
})

test("仅承认官方明确缺页，跨站、错修订和空正文都有链接但不生成预览", async () => {
  for (const input of ["", "http://example.invalid", "条目|另一个条目", ".", "..", "甲\n乙", "汉".repeat(161), "\ud800"]) {
    expect(mcWikiTitle(input)).toBeUndefined()
  }
  const absent = fixture(page({ missing: true }), parsed())
  expect(await readMcWikiArticle("合成", absent)).toEqual({ status: "missing" })
  expect(absent.calls.length).toBe(1)
  for (const invalidUrl of ["https://example.invalid/w/x", "https://zh.minecraft.wiki/user/login", url + "?x=1"]) {
    const cross = fixture(page({ fullurl: invalidUrl }), parsed())
    expect(await readMcWikiArticle("合成", cross)).toEqual({ status: "unavailable", url })
    expect(cross.calls.length).toBe(1)
  }
  for (const lead of [parsed({ revid: 23 }), parsed({ text: "<div>不是正文</div>" }), { error: { code: "missingtitle" } }]) {
    expect(await readMcWikiArticle("别名", fixture(page(), lead))).toEqual({ status: "unavailable", url })
  }
})

test("拒绝重定向、超限、请求取消和上游异常，无需再尝试", async () => {
  const cancelled = new AbortController()
  cancelled.abort()
  let calls = 0
  const invoke = async () => { calls++; return page() }
  expect(await readMcWikiArticle("合成", { signal: cancelled.signal, transport: invoke })).toEqual({ status: "unavailable", url })
  expect(calls).toBe(0)
  for (const respond of [
    () => new Response("限频", { status: 429 }),
    () => Response.redirect("https://example.invalid/w/x"),
    () => new Response("x".repeat(512 * 1024 + 1), { headers: { "Content-Type": "application/json" } }),
  ]) {
    expect(await readMcWikiArticle("合成", { transport: async () => { calls++; return respond() } })).toEqual({ status: "unavailable", url })
  }
  expect(calls).toBe(3)
})

test("合并转发首条保留原文，随后为预览与署名，失败仍给原链接", async () => {
  const lookup = fixture(page(), parsed())
  const read = title => readMcWikiArticle(title, lookup)
  const png = Uint8Array.of(1, 2, 3)
  const run = createMcWikiCommand({ read, render: async () => ({ png }) })
  const reply = await run("合成")
  expect(reply.type).toBe("forward")
  expect(reply.nodes[0]).toBe(url)
  expect(reply.nodes[1]).toEqual({ type: "image", file: png })
  expect(reply.nodes[2]).toContain("中文 Minecraft Wiki 贡献者（修订 22）")
  expect(reply.nodes[2]).toContain(url + "?oldid=22")
  const noRender = createMcWikiCommand({ read, render: async () => { throw new Error("未启用渲染") } })
  expect((await noRender("合成")).nodes.slice(0, 2)).toEqual([url, "条目预览暂时无法生成，请打开原文。"])
  const missing = createMcWikiCommand({ read: async () => ({ status: "missing" }) })
  expect(await missing("合成")).toBe("搜索不到此结果，请检查关键词是否准确无误")
  expect(await missing("")).toBe("用法：#mcwiki 条目名称")
})
