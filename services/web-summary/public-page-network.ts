import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import { hostname, networkInterfaces } from "node:os"
import { checkServerIdentity, type PeerCertificate } from "node:tls"
import { readLocalConfig } from "../../../../lib/config.ts"
import { readLotusGlobalConfig } from "../../../../lib/lotus-global-config.ts"
import { readServerSettings } from "../../../../lib/server.ts"

type Address = { readonly address: string; readonly family: number }
type Lookup = (host: string) => Promise<readonly Address[]>
interface PinnedPageRequest extends RequestInit {
  readonly proxy: false
  readonly tls: {
    readonly serverName: string
    readonly rejectUnauthorized: true
    readonly checkServerIdentity: typeof checkServerIdentity
  }
}
type PublicPageFetch = (url: URL, init: PinnedPageRequest) => Promise<Response>
export type PublicPageControls = {
  readonly hosts?: readonly string[]
  readonly networks?: readonly string[]
}
const installation = new URL("../../../../", import.meta.url)

// IANA special-purpose registries. Permit IPv6 only inside global unicast.
const specialV4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.31.196.0/24", "192.52.193.0/24", "192.88.99.0/24",
  "192.168.0.0/16", "192.175.48.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
  "224.0.0.0/4", "240.0.0.0/4"]
const specialV6 = ["2001::/23", "2001:db8::/32", "2002::/16", "2620:4f:8000::/48", "3fff::/20"]
const redirects = new Set([301, 302, 303, 307, 308])

function ipFamily(family: number) {
  return family === 4 ? "ipv4" : family === 6 ? "ipv6" : undefined
}

function blocks(ranges: readonly string[]) {
  const list = new BlockList()
  for (const range of ranges) {
    const [address, size, extra] = range.split("/")
    const family = address && ipFamily(isIP(address))
    const max = family === "ipv4" ? 32 : 128
    if (!address || !family || extra !== undefined || (size !== undefined && (!/^\d{1,3}$/u.test(size) || Number(size) > max))) {
      throw new Error("网页摘要的本地出站地址配置无效。")
    }
    list.addSubnet(address, size === undefined ? max : Number(size), family)
  }
  return list
}

const special = blocks([...specialV4, ...specialV6])
const ipv6Unicast = blocks(["2000::/3"])

function normalizeHost(name: string) {
  return name.toLowerCase().replace(/\.$/u, "")
}

function dnsName(value: string) {
  return value.length <= 253 && value.includes(".") &&
    value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) &&
    !/\.(?:arpa|example|internal|invalid|local|localhost|onion|test)$/u.test(value)
}

export function parsePublicPageUrl(value: string) {
  if (value.length > 4096 || !/^https:\/\/[^/@?#]+(?:[/?#]|$)/iu.test(value) || /[\\\p{Cc}\s]/u.test(value)) return
  const url = URL.parse(value)
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port || isIP(url.hostname) ||
      !dnsName(normalizeHost(url.hostname))) return
  url.hostname = normalizeHost(url.hostname)
  return url
}

function mapping(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function endpointHost(value: unknown) {
  const url = value instanceof URL ? value : typeof value === "string" ? URL.parse(value) : null
  if (url && (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "ws:" || url.protocol === "wss:")) {
    return normalizeHost(url.hostname.replace(/^\[|\]$/gu, ""))
  }
}

export function parsePublicPageDenyHosts(value: unknown): string[] | undefined {
  if (Array.isArray(value) && value.length <= 32 &&
      value.every(item => typeof item === "string" && dnsName(normalizeHost(item)))) return [...value]
}

export function parsePublicPageDenyNetworks(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 64 || !value.every(item => typeof item === "string")) return
  try {
    blocks(value)
    return [...value]
  } catch {
    return
  }
}

export async function deploymentPublicPageControls(modelUrl?: string, root = installation): Promise<PublicPageControls> {
  const [server, global, bot] = await Promise.all([
    readServerSettings(root, process.env), readLotusGlobalConfig(root), readLocalConfig(root, "bot"),
  ])
  const transfer = mapping(bot.panelTransfer)
  const hostValues = [server.publicUrl, server.https?.publicUrl, server.panelPublicUrl, server.manualCaptchaUrl,
    mapping(global.coin_shop).public_url, transfer.publicOrigin, modelUrl]
  const hosts = hostValues.map(endpointHost).filter((host): host is string => Boolean(host))
  const extra = mapping(global.web_summary)
  const denyHosts = extra.deny_hosts === undefined ? [] : parsePublicPageDenyHosts(extra.deny_hosts)
  const denyNetworks = extra.deny_networks === undefined ? [] : parsePublicPageDenyNetworks(extra.deny_networks)
  if (!denyHosts || !denyNetworks) throw new Error("网页摘要的出站排除配置无效。")
  return { hosts: [...hosts, normalizeHost(server.hostname), normalizeHost(hostname()), ...denyHosts.map(normalizeHost)],
    networks: [...Object.values(networkInterfaces()).flatMap(entries => (entries ?? []).map(entry => entry.cidr ?? entry.address)),
      ...denyNetworks] }
}

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

function publicAddress(value: Address, blocked: BlockList) {
  const family = ipFamily(value.family)
  return family !== undefined && value.family === isIP(value.address) && !value.address.includes("%") &&
    !special.check(value.address, family) && !blocked.check(value.address, family) &&
    (family === "ipv4" || ipv6Unicast.check(value.address, family))
}

async function outboundAddressPolicy(controls: PublicPageControls, resolve: Lookup, signal: AbortSignal) {
  const hosts = new Set(controls.hosts ?? [])
  const block = blocks(controls.networks ?? [])
  await Promise.all([...hosts].map(async host => {
    if (isIP(host)) {
      block.addAddress(host, ipFamily(isIP(host)))
    } else if (dnsName(host)) {
      const matches = await withAbort(resolve(host), signal).catch((error: unknown) => {
        if (["ENOTFOUND", "ENODATA"].includes(String((error as NodeJS.ErrnoException).code))) return []
        throw error
      })
      for (const { address, family } of matches) {
        if (!ipFamily(family) || isIP(address) !== family || address.includes("%")) throw new Error("受管地址的 DNS 答复无效。")
        block.addAddress(address, ipFamily(family))
      }
    }
  }))
  return { hosts, block }
}

export function createPublicPageNetwork({ fetcher = fetch, resolve = host => lookup(host, { all: true, verbatim: true }),
  controls = deploymentPublicPageControls }: {
  readonly fetcher?: PublicPageFetch
  readonly resolve?: Lookup
  readonly controls?: (modelUrl?: string) => Promise<PublicPageControls>
} = {}) {
  async function get(url: URL, addresses: readonly Address[], signal: AbortSignal) {
    for (const address of addresses.slice(0, 3)) {
      signal.throwIfAborted()
      const wire = new URL(url)
      wire.hostname = address.family === 6 ? "[" + address.address + "]" : address.address
      wire.hash = ""
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(3500)])
      try {
        return await fetcher(wire, { method: "GET", headers: { Host: url.hostname, Accept: "text/html" },
          redirect: "manual", proxy: false, keepalive: false, credentials: "omit", signal: requestSignal,
          tls: { serverName: url.hostname, rejectUnauthorized: true, checkServerIdentity(name: string, certificate: PeerCertificate) {
            return name === url.hostname ? checkServerIdentity(name, certificate) : new Error("网页证书的域名不匹配。")
          } },
        })
      } catch (error) {
        signal.throwIfAborted()
        const code = (error as NodeJS.ErrnoException).code
        if (!requestSignal.aborted && !["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"].includes(code ?? "")) return
      }
    }
  }

  return async function request(initial: URL, signal: AbortSignal, modelUrl?: string) {
    signal.throwIfAborted()
    let url = parsePublicPageUrl(initial.href)
    if (!url) return
    url.hash = ""
    const policy = await outboundAddressPolicy(await withAbort(controls(modelUrl), signal), resolve, signal)
    const visited = new Set<string>()
    for (let hop = 0; hop <= 3; hop++) {
      signal.throwIfAborted()
      if (policy.hosts.has(url.hostname) || visited.has(url.href)) return
      visited.add(url.href)
      const addresses = await withAbort(resolve(url.hostname), signal)
      if (!addresses.length || addresses.length > 32 || !addresses.every(address => publicAddress(address, policy.block))) return
      const response = await get(url, addresses, signal)
      if (!response || response.redirected) {
        await response?.body?.cancel().catch(() => undefined)
        return
      }
      if (!redirects.has(response.status)) return response
      await response.body?.cancel().catch(() => undefined)
      const location = response.headers.get("location")
      if (!location || location.length > 4096 || /[\\\p{Cc}\s]/u.test(location)) return
      const next = URL.parse(location, url)
      const validated = next && parsePublicPageUrl(next.href)
      if (!validated) return
      validated.hash = ""
      url = validated
    }
  }
}
