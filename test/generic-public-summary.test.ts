import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { MessageFallbackContext } from "../../../lib/commands.ts"
import { createWebSummary } from "../services/web-summary/command.ts"
import { createPublicPageReader, parsePublicPageHtml } from "../services/web-summary/public-page.ts"
import { createPublicPageNetwork, deploymentPublicPageControls, parsePublicPageUrl } from "../services/web-summary/public-page-network.ts"

const publicUrl = "https://www.iana.org/domains/example"
const approved = { address: "192.0.43.8", family: 4 }
const article = "<title>Public informational page</title><main><p>This example contains visible explanatory article text only.</p><h1>Public informational page</h1><p hidden>Private cover text</p></main>"
const signal = new AbortController().signal
const emptyControls = async () => ({ hosts: [], networks: [] })
const html = (value = article) => new Response(value, { headers: { "Content-Type": "text/html" } })

test("通用 URL 只接受 HTTPS 的正常 DNS 域名且保留目标查询", () => {
  expect(parsePublicPageUrl(publicUrl + "?topic=example#details")?.href).toBe(publicUrl + "?topic=example#details")
  expect(parsePublicPageUrl("https://WWW.IANA.ORG./domains")?.hostname).toBe("www.iana.org")
  for (const value of ["http://www.iana.org/", "https://localhost/", "https://127.0.0.1/",
    "https://[::1]/", "https://www.iana.org:8443/", "https://user@www.iana.org/", "https://www.invalid/"]) {
    expect(parsePublicPageUrl(value)).toBeUndefined()
  }
})

test("地址策略拒绝非公网地址、已声明部署地址及混合 DNS，且无 HTTP 请求", async () => {
  const controls = async () => ({ hosts: ["service.example.net"], networks: ["151.101.16.0/24"] })
  let calls = 0
  const candidate = createPublicPageReader(createPublicPageNetwork({
    controls,
    resolve: async host => host === "service.example.net" ? [{ address: "151.101.1.69", family: 4 }] : answers,
    fetcher: async () => { calls++; throw new Error("被拒地址不得请求") },
  }))
  let answers: { address: string; family: number }[] = []
  for (const address of ["127.0.0.1", "10.1.0.12", "192.168.0.1", "169.254.1.1", "100.64.0.1",
    "192.0.2.1", "::ffff:192.0.43.8", "fc00::1", "2001:db8::1", "151.101.1.69", "151.101.16.8"]) {
    answers = [approved, { address, family: address.includes(":") ? 6 : 4 }]
    expect(await candidate(publicUrl, signal)).toBeUndefined()
  }
  expect(await candidate("https://service.example.net/health", signal)).toBeUndefined()
  expect(calls).toBe(0)
})

test("每跳按逻辑域名重新做地址策略，固定连接 IP 并以当跳原域验 TLS", async () => {
  const calls: { ip: string; host?: string; path: string }[] = []
  const names: string[] = []
  const target = "https://www.rfc-editor.org/info/rfc2606"
  const rfcIp = { address: "104.18.21.81", family: 4 }
  let redirect = target
  let response: () => Response = html
  const network = createPublicPageNetwork({
    controls: emptyControls,
    resolve: async name => {
      names.push(name)
      if (name === "protected.example.net") return [{ address: "192.168.3.1", family: 4 }]
      return [name === "www.rfc-editor.org" ? rfcIp : approved]
    },
    async fetcher(input, init) {
      const headers = new Headers(init?.headers)
      const host = headers.get("Host")
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual", proxy: false, keepalive: false,
        tls: { serverName: host, rejectUnauthorized: true, checkServerIdentity: expect.any(Function) } })
      expect(headers.has("Cookie")).toBe(false)
      expect(headers.has("Authorization")).toBe(false)
      expect(input.hash).toBe("")
      calls.push({ ip: input.hostname, host: host ?? undefined, path: input.pathname })
      return input.hostname === approved.address ? Response.redirect(redirect) : response()
    },
  })
  const read = createPublicPageReader(network)
  expect(await read(publicUrl + "#details", signal)).toMatchObject({ title: "Public informational page", link: publicUrl + "#details", text:
    "This example contains visible explanatory article text only." })
  expect(names.splice(0)).toEqual(["www.iana.org", "www.rfc-editor.org"])
  expect(calls.splice(0)).toEqual([{ ip: approved.address, host: "www.iana.org", path: "/domains/example" },
    { ip: rfcIp.address, host: "www.rfc-editor.org", path: "/info/rfc2606" }])
  redirect = "https://protected.example.net/control"
  expect(await read(publicUrl, signal)).toBeUndefined()
  expect(calls.splice(0)).toHaveLength(1)
  redirect = target
  for (const unusable of [
    () => new Response(article, { status: 403, headers: { "Content-Type": "text/html" } }),
    () => new Response(article, { headers: { "Content-Type": "application/json" } }),
    () => new Response(article, { headers: { "Content-Type": "text/html", "Content-Length": String(1048577) } }),
    () => html(" ".repeat(1048577)),
  ]) {
    response = unusable
    expect(await read(publicUrl, signal)).toBeUndefined()
  }
})

test("正文提取丢弃隐藏节点、登录与平台挑战，对明确付费字段返回不可用", () => {
  expect(parsePublicPageHtml(article, publicUrl)?.text).not.toContain("Private cover")
  expect(parsePublicPageHtml("<title>Sign in</title>" + article, publicUrl)).toBeUndefined()
  expect(parsePublicPageHtml(article.replace("<main>", "<main><form><input type=password></form>"), publicUrl)).toBeUndefined()
  expect(parsePublicPageHtml(article.replace("<main>", "<main><div id=challenge-form></div>"), publicUrl)).toBeUndefined()
  expect(parsePublicPageHtml(article.replace("<title>", "<script type=application/ld+json>{\"isAccessibleForFree\":false}</script><title>"), publicUrl)).toBeUndefined()
})

test("来源策略继承宿主、商店、面板迁移和模型声明的受管主机", async () => {
  const base = await mkdtemp(join(tmpdir(), "lotus-public-summary-"))
  try {
    const files = join(base, "config")
    await mkdir(files)
    await Promise.all([
      writeFile(join(files, "server.yaml"), "url: https://bot.example.net/\nhttps: { url: https://tls.example.net/, key: fixture.key, cert: fixture.crt }\n"),
      writeFile(join(files, "global.yaml"), "coin_shop: {public_url: 'https://shop.example.net/'}\nweb_summary: {deny_hosts: [extra.example.net], deny_networks: [151.101.16.0/24]}\n"),
      writeFile(join(files, "bot.yaml"), "panelTransfer: {publicOrigin: https://TRANSFER.EXAMPLE.NET./}\n"),
    ])
    const result = await deploymentPublicPageControls("https://models.example.net/v1", pathToFileURL(base + "/"))
    expect(result.hosts).toEqual(expect.arrayContaining(["bot.example.net", "tls.example.net", "shop.example.net",
      "transfer.example.net", "models.example.net", "extra.example.net"]))
    expect(result.networks).toContain("151.101.16.0/24")
  } finally { await rm(base, { recursive: true, force: true }) }
})

test("只有显式普通网页进入通用链，已有来源继续使用独立读取", async () => {
  let reads = 0, fixed = 0, available = true
  const summary = createWebSummary({
    settings: async () => ({ youtube: true, youtubeMusic: true, telegram: true, v2ex: true, articles: true,
      x: true, private: false, trustedTelegramUsers: [], trustedXUsers: [] }),
    model: {
      settings: async () => ({ summaryEnabled: false, summaryMode: "general", summaryBaseUrl: "https://model.example.net/",
        summaryModel: "", summaryApiKeyConfigured: false }),
      summarize: async () => { throw new Error("模型关闭") },
    },
    publicPage: async (link, active, model) => {
      expect(link).toBe(available ? publicUrl : publicUrl + "#details")
      expect(active.aborted).toBe(false)
      expect(model).toBe("https://model.example.net/")
      reads++
      if (available) return { title: "匿名文档", text: "公开正文", link }
    },
    fetcher: async () => { fixed++; return new Response(null, { status: 403 }) },
    render: async () => Buffer.from("fixture"),
  })
  const context = (normalizedMessage: string) => ({
    normalizedMessage, message_type: "group", isMaster: false, user_id: 111, group_id: 222,
  }) as MessageFallbackContext
  expect(summary.features(context(publicUrl))).toEqual([])
  expect(await summary.fallback(publicUrl, context(publicUrl))).toBeUndefined()
  const explicit = "#总结一下 " + publicUrl
  expect(summary.features(context(explicit))).toEqual(["[media] 网页总结"])
  expect(await summary.fallback(explicit, context(explicit))).toEqual([
    { type: "image", file: Buffer.from("fixture") }, { type: "text", text: publicUrl },
  ])
  const known = "#总结一下 https://github.com/oven-sh/bun"
  expect(await summary.fallback(known, context(known))).toContain("https://github.com/oven-sh/bun")
  expect({ reads, fixed }).toEqual({ reads: 1, fixed: 1 })
  available = false
  const missing = explicit + "#details"
  expect(await summary.fallback(missing, context(missing))).toBe("暂无法读取公开原文。\n" + publicUrl + "#details")
})
