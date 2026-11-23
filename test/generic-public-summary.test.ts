import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { MessageFallbackContext } from "../../../lib/commands.ts"
import { panelApi } from "../../../lib/panel.ts"
import { panelGuobaRoutes } from "../../../lib/panel-guoba-routes.ts"
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

test("面板源站排除项沿用旧配置位置，写入后实时应用且保留受管地址", async () => {
  const base = await mkdtemp(join(tmpdir(), "lotus-public-summary-panel-"))
  try {
    const legacyConfig = join(base, "config", "config")
    const file = join(legacyConfig, "global.yaml")
    const data = join(base, "data")
    const plugin = join(base, "plugin")
    await Promise.all([mkdir(legacyConfig, { recursive: true }), mkdir(join(data, "media"), { recursive: true }), mkdir(plugin)])
    const root = pathToFileURL(base + "/")
    const contents = [
      "# 顶层注释", "coin_shop:", "  public_url: https://shop.example.net/ # 受管服务", "web_summary: # 保留配置组",
      "  deny_hosts: # 站点列表", "    - OLD.Example.NET. # 保留这条注释", "  deny_networks: [151.101.16.0/24] # 内联序列注释",
      "  extension: preserve # 保留兄弟项", "unrelated: [fixture] # 保留其他项", "",
    ].join("\n")
    await Promise.all([
      writeFile(file, contents),
      writeFile(join(data, "media", "official-links.yaml"), "summaryApiKey: fixture-only-key-never-returned\n"),
      writeFile(join(plugin, "guoba.support.js"), `
        import { supportGuoba as source } from ${JSON.stringify(new URL("../guoba-settings.ts", import.meta.url).href)};
        export const supportGuoba = () => source(${JSON.stringify(data)}, undefined, new URL(${JSON.stringify(root.href)}));
      `),
    ])

    const routes = panelGuobaRoutes(new Map([["media", { path: plugin, packageName: "media" }]]))
    const api = panelApi("isolated-token", [], routes)
    const panel = (method: string, values?: Record<string, unknown>, authenticated = true) =>
      api(new Request("https://panel.example.net/panel/api/guoba/media", {
        method, headers: { ...(authenticated ? { Authorization: "Bearer isolated-token" } : {}),
          ...(values ? { "Content-Type": "application/json" } : {}) },
        ...(values ? { body: JSON.stringify(values) } : {}),
      }))
    expect((await panel("GET", undefined, false))?.status).toBe(401)
    expect((await panel("PUT", { "web_summary.deny_hosts": [] }, false))?.status).toBe(401)
    const original = await (await panel("GET"))?.json()
    expect(original.values).toMatchObject({
      "web_summary.deny_hosts": ["OLD.Example.NET."], "web_summary.deny_networks": ["151.101.16.0/24"],
    })
    expect(original.configuredPasswords).toContain("officialLinks.summaryApiKey")
    expect(JSON.stringify(original)).not.toContain("fixture-only-key-never-returned")
    for (const body of [
      { "web_summary.deny_hosts": ["https://example.org/"] }, { "web_summary.deny_hosts": ["*.example.org"] },
      { "web_summary.deny_networks": ["151.101.5.3/33"], "web_summary.deny_hosts": ["suppressed.example.org"] },
      { "web_summary.deny_networks": ["2001:4860::/129"] }, { "web_summary.deny_networks": ["not-a-network"] },
    ]) expect((await panel("PUT", body))?.status).toBe(422)
    expect((await panel("PUT", { "web_summary": { "unknown": ["example.org"] } }))?.status).toBe(400)
    expect(await readFile(file, "utf8")).toBe(contents)

    let fetched = 0
    const online = createPublicPageNetwork({
      controls: (model) => deploymentPublicPageControls(model, root),
      resolve: async host => [{ address: host === "net.example.org" ? "93.184.201.2"
        : host === "allowed.example.org" ? "192.0.43.8" : "151.101.1.69", family: 4 }],
      fetcher: async () => { fetched++; return html() },
    })
    const allowed = new URL("https://allowed.example.org/")
    const network = new URL("https://net.example.org/")
    expect((await online(allowed, signal))?.status).toBe(200)
    expect((await online(network, signal))?.status).toBe(200)
    expect((await panel("PUT", {
      "web_summary.deny_hosts": ["OLD.Example.NET.", "allowed.example.org"],
      "web_summary.deny_networks": ["93.184.201.0/24", "2001:4860::/32"],
    }))?.status).toBe(200)
    expect(await online(allowed, signal)).toBeUndefined()
    expect(await online(network, signal)).toBeUndefined()
    expect(fetched).toBe(2)

    const changed = await readFile(file, "utf8")
    for (const fragment of ["# 顶层注释", "# 受管服务", "# 保留配置组", "# 站点列表", "# 保留这条注释",
      "# 内联序列注释", "extension: preserve # 保留兄弟项", "unrelated: [fixture] # 保留其他项"]) {
      expect(changed).toContain(fragment)
    }
    expect((await panel("PUT", { "web_summary.deny_hosts": [], "web_summary.deny_networks": [] }))?.status).toBe(200)
    const after = await (await panel("GET"))?.json()
    expect(after?.values).toMatchObject({ "web_summary.deny_hosts": [], "web_summary.deny_networks": [] })
    expect(JSON.stringify(after)).not.toContain("fixture-only-key-never-returned")
    expect((await deploymentPublicPageControls("https://model.example.org/", root)).hosts)
      .toEqual(expect.arrayContaining(["shop.example.net", "model.example.org"]))
    expect(await online(new URL("https://shop.example.net/"), signal)).toBeUndefined()
    expect(await online(new URL("https://model.example.org/"), signal, "https://model.example.org/v1")).toBeUndefined()
    expect((await online(network, signal))?.status).toBe(200)
    expect(fetched).toBe(3)

    const alias = "shared: &preset {deny_hosts: [shared.example.net]}\nweb_summary: *preset\n"
    await writeFile(file, alias)
    expect((await panel("PUT", { "web_summary.deny_hosts": [] }))?.status).toBe(500)
    expect(await readFile(file, "utf8")).toBe(alias)

    const fresh = "# 保留空配置的注释\n"
    await writeFile(file, fresh)
    expect((await panel("PUT", { "web_summary.deny_hosts": ["new.example.net"] }))?.status).toBe(200)
    const readback = await (await panel("GET"))?.json()
    expect(readback.values).toMatchObject({ "web_summary.deny_hosts": ["new.example.net"], "web_summary.deny_networks": [] })
    expect(await readFile(file, "utf8")).toStartWith(fresh)
  } finally { await rm(base, { recursive: true, force: true }) }
})
