import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { getOfficialArticle, parseOfficialArticle, type OfficialArticleFetch } from "../services/web-summary/official-article.ts"

const github = "https://github.com/oven-sh/bun"
const explicit = github + "/blob/main/README.md"
const sspai = "https://sspai.com/post/116181"
const chinadaily = "https://global.chinadaily.com.cn/a/202611/09/WS6af11ce5e4b03ebf8519b305.html"
const signal = new AbortController().signal

const sample = "# 标题\n\n    原样 README\n"
const bytes = Buffer.from(sample)
const githubResponse = (changes: Record<string, unknown> = {}) => Response.json({
  name: "README.md", path: "README.md", type: "file", encoding: "base64", size: bytes.length,
  sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
  content: bytes.toString("base64").replace(/(.{14})/gu, "$1\n"), html_url: explicit,
  url: "https://api.github.com/repos/oven-sh/bun/contents/README.md?ref=main",
  download_url: "https://example.invalid/untrusted", ...changes,
})
const asHtml = (value: string) => new Response(value, { headers: { "Content-Type": "text/html; charset=utf-8" } })
const metadata = (source: string, type: string, url?: string) => `<head><meta property="og:url" content="${source}">
 <script type="application/ld+json">${JSON.stringify({ "@type": type, url, author: { name: "官方署名" } })}</script></head>`
const sspaiBody = `<article><h1 id="article-title">公开文章</h1><div class="article__main__content"><p>段落一<br>续句</p><p>段落二</p>
 <span hidden>不显示</span><script>恶意文本</script><template>不可见</template></div><aside>广告</aside></article>`
const dailyBody = '<div class="content-left"><h1>News article</h1><div id="Content"><p>Original body.</p></div><aside>Recommendations</aside></div>'

test("固定官方路径仅识别仓库根、明确 README 和带文章身份的地址", () => {
  expect(parseOfficialArticle(github + "/?tab=readme-ov-file#install")).toMatchObject({ source: "github", link: github })
  expect(parseOfficialArticle(explicit + "?plain=1")).toMatchObject({ source: "github", link: explicit, file: { ref: "main", path: "README.md" } })
  expect(parseOfficialArticle(sspai + "?utm_source=share")).toEqual({ source: "sspai", link: sspai })
  expect(parseOfficialArticle(chinadaily)).toEqual({ source: "chinadaily", link: chinadaily })
  for (const denied of [github + "/issues/1", github + "/blob/main/package.json", github + "/tree/main",
    github + "/blob/feature/name/README.md", "https://github.com@evil.example/oven-sh/bun",
    "https://sspai.com:8081/post/116181", "https://sspai.com/", "https://global.chinadaily.com.cn/a/index.html",
    "https://evil.example/post/116181", "http://127.0.0.1:8080/"]) expect(parseOfficialArticle(denied)).toBeUndefined()
})

test("GitHub 绑定同一仓库、默认或明确分支、README 字节和 Git blob SHA，始终只读官方 API", async () => {
  const calls: string[] = []
  const fetcher: OfficialArticleFetch = async (url, init) => {
    calls.push(url.href)
    expect(init).toMatchObject({ redirect: "error", credentials: "omit", signal, headers: { Accept: "application/vnd.github+json" } })
    return githubResponse()
  }
  for (const link of [github, explicit]) {
    expect(await getOfficialArticle(parseOfficialArticle(link)!, fetcher, signal)).toEqual({
      title: "oven-sh/bun · README.md", owner: "oven-sh", text: sample.trim(), link,
    })
  }
  expect(calls).toEqual(["https://api.github.com/repos/oven-sh/bun/readme",
    "https://api.github.com/repos/oven-sh/bun/contents/README.md?ref=main"])
  for (const patch of [{ html_url: explicit.replace("/bun/", "/other/") },
    { url: "https://api.github.com/repos/oven-sh/other/contents/README.md?ref=main" },
    { url: "https://api.github.com/repos/oven-sh/bun/contents/README.md?ref=other" },
    { sha: "0".repeat(40) }, { size: bytes.length + 1 }, { type: "symlink" }, { content: "A?=" },
  ]) expect(await getOfficialArticle(parseOfficialArticle(explicit)!, async () => githubResponse(patch), signal)).toBeUndefined()
  const forged = { ...parseOfficialArticle(github)!, link: "http://127.0.0.1:9/" }
  expect(await getOfficialArticle(forged, async () => { throw new Error("绝不能出站") }, signal)).toBeUndefined()
})

test("仅接对应文章正文，错 ID、付费外壳、跨站跳转和超限响应均不可用", async () => {
  const scenarios = [
    [sspai, metadata("/post/116181", "Article") + sspaiBody, "公开文章", "段落一\n续句\n段落二"],
    [chinadaily, metadata(chinadaily, "NewsArticle", chinadaily) + dailyBody, "News article", "Original body."],
  ] as const
  for (const [link, html, title, text] of scenarios) {
    const input = parseOfficialArticle(link)!
    const fetcher: OfficialArticleFetch = async (url, init) => {
      expect(url.href).toBe(link)
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", signal, headers: { Accept: "text/html" } })
      return asHtml(html)
    }
    expect(await getOfficialArticle(input, fetcher, signal)).toEqual({ title, owner: "官方署名", text, link })
    expect(await getOfficialArticle(input, async () => asHtml(html.replace('property="og:url" content="', 'property="og:url" content="https://evil.example/')), signal)).toBeUndefined()
    expect(await getOfficialArticle(input, async () => asHtml("<h1>登录或订阅</h1>"), signal)).toBeUndefined()
    expect(await getOfficialArticle(input, async () => Response.redirect("https://evil.example/"), signal)).toBeUndefined()
    expect(await getOfficialArticle(input, async () => asHtml(" ".repeat(1024 * 1024 + 1)), signal)).toBeUndefined()
  }
  const mismatch = metadata("/post/116180", "Article") + sspaiBody
  expect(await getOfficialArticle(parseOfficialArticle(sspai)!, async () => asHtml(mismatch), signal)).toBeUndefined()
})
