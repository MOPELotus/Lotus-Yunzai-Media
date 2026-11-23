import { expect, test } from "bun:test"
import { getArxiv, parseArxiv } from "../services/web-summary/arxiv.ts"

const title = "A & B"
const feed = (id = "1706.03762v1") => new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry><id>http://arxiv.org/abs/${id}</id><title>A &amp; B</title>
  <author><name>作者一</name></author><author><name>作者二</name></author><summary>摘要  内容</summary></entry>
  </feed>`, { headers: { "Content-Type": "application/atom+xml;charset=utf-8" } })

test("arXiv 从官方标题、作者和摘要读取，指定版本不切到其他版本", async () => {
  const pdf = parseArxiv("https://arxiv.org/pdf/1706.03762v1.pdf?download=1")!
  expect(pdf).toEqual({ source: "arxiv", id: "1706.03762v1", link: "https://arxiv.org/abs/1706.03762v1" })
  expect(parseArxiv("https://arxiv.org/pdf/hep-th/9901001")).toMatchObject({ id: "hep-th/9901001" })
  for (const value of [
    "https://arxiv.org.example/abs/1706.03762v1", "https://arxiv.org:8443/abs/1706.03762v1",
    "https://user@arxiv.org/abs/1706.03762v1", "https://arxiv.org/abs/1706.03762v0",
  ]) expect(parseArxiv(value)).toBeUndefined()
  const signal = new AbortController().signal
  expect(await getArxiv(pdf, async (url, init) => {
    expect(url.href).toBe("https://export.arxiv.org/api/query?id_list=1706.03762v1")
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", signal })
    return feed()
  }, signal)).toEqual({ title, owner: "作者一、作者二", text: "摘要 内容", link: pdf.link })
  expect(await getArxiv(pdf, async () => feed("1706.03762v2"), signal)).toBeUndefined()
  expect(await getArxiv(pdf, async () => feed("1706.03763v1"), signal)).toBeUndefined()
  const latest = parseArxiv("https://arxiv.org/abs/1706.03762")!
  expect((await getArxiv(latest, async () => feed("1706.03762v2"), signal))?.link).toBe("https://arxiv.org/abs/1706.03762v2")
})
