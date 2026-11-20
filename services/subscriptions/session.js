import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "yaml"

const platforms = {
  bilibili: {
    prefix: "Yz:yuki:bili:cookie",
    origin: "https://api.bilibili.com",
    paths: new Set(["/x/polymer/web-dynamic/v1/feed/space"]),
    domains: ["api.bilibili.com", "bilibili.com"],
    names: ["SESSDATA", "DedeUserID", "DedeUserID__ckMd5", "bili_jct", "buvid3", "buvid4", "_uuid", "b_nut", "b_lsid", "buvid_fp", "sid", "bili_ticket", "bili_ticket_expires"],
    identity: ["SESSDATA"],
  },
  weibo: {
    prefix: "Yz:yuki:weibo:cookie",
    origin: "https://m.weibo.cn",
    paths: new Set(["/api/container/getIndex", "/api/config", "/profile/info"]),
    domains: ["m.weibo.cn", "weibo.cn"],
    names: ["SUB", "SUP", "SUBP", "SSOLoginState", "ALF", "SCF", "SRF", "SRT", "X-XSRF-TOKEN", "_T_WM", "M_WEIBOCN_PARAMS", "WEIBOCN_FROM", "tid"],
    identity: ["SUB", "SUP", "SUBP"],
    xsrf: "X-XSRF-TOKEN",
  },
}

const validValue = (value) => typeof value === "string" && value.length <= 4096 &&
  /^[\x21-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/u.test(value) && !/^deleted$/iu.test(value)
const allowed = (platform, url) => url.origin === platform.origin && !url.username && !url.password && platform.paths.has(url.pathname)
const keyFor = (platform, domain, name) => `${platform.prefix}:${domain}:${name}`

function matchesPath(path, pathname) {
  return path === pathname || pathname.startsWith(path.endsWith("/") ? path : path + "/")
}

function cookieParts(header) {
  return header.split(";").flatMap((part) => {
    const split = part.indexOf("=")
    return split < 0 ? [] : [[part.slice(0, split).trim(), part.slice(split + 1).trim()]]
  })
}

export function biliLocalPath(directory) {
  return join(directory, "yuki-plugin", "biliCookie.yaml")
}

export function parseBiliLocal(value) {
  if (typeof value !== "string" || value.length > 32_768 || /[\r\n]/u.test(value)) return
  const names = platforms.bilibili.names
  const fields = new Map(cookieParts(value).filter(([name, field]) => names.includes(name) && validValue(field)))
  if (fields.has("SESSDATA")) return { fields, source: "local" }
}

export async function readBiliLocal(directory) {
  let file
  try {
    file = await open(biliLocalPath(directory), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 32_768) return
    return parseBiliLocal(parse(await file.readFile("utf8")))
  } catch {
    return
  } finally {
    await file?.close()
  }
}

async function storedSession(redis, platform, url) {
  if (typeof redis?.mGet !== "function") return
  const keys = []
  const candidates = []
  for (const name of platform.names) {
    for (const domain of platform.domains) {
      for (const savedDomain of [`.${domain}`, domain]) {
        const key = keyFor(platform, savedDomain, name)
        keys.push(key, key + ":meta")
        candidates.push({ name, key, domain })
      }
    }
  }
  const values = await redis.mGet(keys)
  const fields = new Map()
  const records = new Map()
  for (const [index, entry] of candidates.entries()) {
    const { name, domain, key } = entry
    const value = values[index * 2]
    if (fields.has(name) || !validValue(value)) continue
    let path = "/"
    try {
      const meta = values[index * 2 + 1]
      if (meta) path = JSON.parse(meta)?.path ?? "/"
    } catch {
      continue
    }
    if (typeof path !== "string" || !path.startsWith("/") || !matchesPath(path, url.pathname)) continue
    fields.set(name, value)
    records.set(keyFor(platform, domain, name), { name, key, value })
  }
  const proof = [...records.values()].find(({ name }) => platform.identity.includes(name))
  if (proof) return { fields, records, proof, source: "session" }
}

function rotation(platform, url, headers) {
  const result = new Map()
  for (const header of headers.getSetCookie()) {
    const parts = cookieParts(header)
    if (!parts.length) continue
    const [name, value] = parts[0]
    if (!platform.names.includes(name)) continue
    const attributes = new Map(parts.slice(1).map(([name, value]) => [name.toLowerCase(), value]))
    const domain = (attributes.get("domain") ?? url.hostname).toLowerCase().replace(/^\./u, "")
    if (!platform.domains.includes(domain) || !(domain === url.hostname || url.hostname.endsWith("." + domain))) continue
    const path = attributes.get("path") ?? (url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/")
    if (!path.startsWith("/") || !matchesPath(path, url.pathname)) continue
    let seconds
    const maxAge = attributes.get("max-age")
    if (maxAge && /^-?\d+$/u.test(maxAge)) seconds = Number(maxAge)
    else if (attributes.has("expires")) seconds = Math.floor((Date.parse(attributes.get("expires")) - Date.now()) / 1000)
    if (seconds !== undefined && !Number.isSafeInteger(seconds)) continue
    if ((seconds === undefined || seconds > 0) && !validValue(value)) continue
    result.set(keyFor(platform, domain, name), { name, domain, value, path, seconds })
  }
  return result
}

const applyRotation = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
for i = 2, #KEYS do
  local offset = (i - 2) * 3 + 2
  local current = redis.call('GET', KEYS[i]) or ''
  if current ~= ARGV[offset] then return 0 end
end
local proofTTL = redis.call('PTTL', KEYS[1])
for i = 2, #KEYS do
  local offset = (i - 2) * 3 + 2
  local value = ARGV[offset + 1]
  local entry = cjson.decode(ARGV[offset + 2])
  local metadata = KEYS[i] .. ':meta'
  local seconds = entry.seconds
  if seconds ~= nil and seconds <= 0 then
    redis.call('DEL', KEYS[i], metadata)
  else
    local ttl = seconds and (seconds * 1000) or redis.call('PTTL', KEYS[i])
    if ttl <= 0 and seconds == nil and ttl ~= -1 then ttl = proofTTL end
    if ttl > 0 then
      redis.call('SET', KEYS[i], value, 'PX', ttl)
      redis.call('SET', metadata, entry.meta, 'PX', ttl)
    elseif ttl == -1 then
      redis.call('SET', KEYS[i], value)
      redis.call('SET', metadata, entry.meta)
    end
  end
end
return 1`

export class ExpiredSubscriptionSession extends Error {}

export function subscriptionSession(id, directory, getRedis) {
  const platform = platforms[id]
  const rejected = new Set()
  return {
    async candidates(url) {
      if (!allowed(platform, url)) return []
      const entries = []
      if (id === "bilibili") {
        const local = await readBiliLocal(directory)
        if (local) entries.push(local)
      }
      try {
        const session = await storedSession(getRedis(), platform, url)
        if (session) entries.push(session)
      } catch {
        // A subscription still works anonymously when the previous store is unavailable.
      }
      return entries.filter((entry) => !rejected.has(sessionCredentialKey(platform, entry)))
    },
    headers(session, headers) {
      const result = new Headers(headers)
      result.set("Cookie", [...session.fields].map(([n, v]) => `${n}=${v}`).join("; "))
      const xsrf = session.fields.get(platform.xsrf)
      if (xsrf) result.set(platform.xsrf, xsrf)
      return result
    },
    reject(session) {
      if (rejected.size >= 8) rejected.clear()
      rejected.add(sessionCredentialKey(platform, session))
    },
    async rotate(session, url, headers) {
      if (!allowed(platform, url) || session.source !== "session") return
      const changes = rotation(platform, url, headers)
      if (!changes.size) return
      const keys = [session.proof.key]
      const values = [session.proof.value]
      for (const [logicalKey, { name, domain, value, path, seconds }] of changes) {
        const original = session.records.get(logicalKey)
        keys.push(original?.key ?? keyFor(platform, `.${domain}`, name))
        values.push(original?.value ?? "", value, JSON.stringify({ seconds, meta: JSON.stringify({ path, secure: true }) }))
      }
      try {
        return await getRedis()?.eval(applyRotation, { keys, arguments: values }) === 1
      } catch {
        // A successful feed response is independent of a local renewal write.
      }
    },
  }
}

function sessionCredentialKey(platform, entry) {
  const values = platform.identity.map((name) => entry.fields.get(name) ?? "")
  // The API can renew the request's CSRF token while keeping the account cookie.
  if (platform.xsrf) values.push(entry.fields.get(platform.xsrf) ?? "")
  return entry.source + ":" + createHash("sha256").update(values.join("\0")).digest("hex")
}

export async function readWithSubscriptionSession(transport, sessions, url, options, decode) {
  const candidates = [...(await sessions?.candidates(url) ?? []), undefined]
  let retriedRenewal = false
  while (candidates.length) {
    const session = candidates.shift()
    options.signal?.throwIfAborted()
    const response = await transport(url, session ? { ...options, headers: sessions.headers(session, options.headers) } : options)
    try {
      const data = await decode(response)
      if (session) await sessions.rotate(session, url, response.headers)
      return data
    } catch (error) {
      if (!session || !(error instanceof ExpiredSubscriptionSession)) throw error
      sessions.reject(session)
      if (await sessions.rotate(session, url, response.headers) && !retriedRenewal) {
        retriedRenewal = true
        candidates.splice(0, candidates.length, ...await sessions.candidates(url), undefined)
      }
    }
  }
}

const biliAccountFields = ["SESSDATA", "DedeUserID", "DedeUserID__ckMd5", "bili_jct", "bili_ticket", "bili_ticket_expires"]
const biliLoginLock = "lotus-yunzai:media:dynamic:bilibili:signin"
const releaseBiliLock = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0"
const biliFeedURL = new URL("/x/polymer/web-dynamic/v1/feed/space", platforms.bilibili.origin)

function biliFieldKeys(names) {
  const platform = platforms.bilibili
  return names.flatMap((name) => platform.domains.flatMap((domain) => [
    keyFor(platform, "." + domain, name), keyFor(platform, domain, name),
  ]))
}

const replaceBiliIdentity = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
for i = 1, tonumber(ARGV[2]) do
  if (redis.call('GET', KEYS[i + 1]) or '') ~= ARGV[i + 2] then return 0 end
end
for i = 1, tonumber(ARGV[3 + tonumber(ARGV[2])]) do
  redis.call('DEL', KEYS[i + 1], KEYS[i + 1] .. ':meta')
end
local start = 4 + tonumber(ARGV[2])
for i = 2 + tonumber(ARGV[start - 1]), #KEYS do
  local offset = start + (i - (2 + tonumber(ARGV[start - 1]))) * 3
  redis.call('SET', KEYS[i], ARGV[offset], 'EX', ARGV[offset + 1])
  redis.call('SET', KEYS[i] .. ':meta', ARGV[offset + 2], 'EX', ARGV[offset + 1])
end
return 1`

export async function readBiliLogin(redis) {
  const session = await storedSession(redis, platforms.bilibili, biliFeedURL)
  if (!session) return
  const ttl = typeof redis.pTTL === "function" ? await redis.pTTL(session.proof.key) : undefined
  const expiresAt = ttl === -1 ? null : ttl > 0 ? Date.now() + ttl : undefined
  return { ...session, expiresAt }
}

export function biliIssuedLogin(headers, url) {
  const issued = new Map()
  for (const cookie of rotation(platforms.bilibili, url, headers).values()) {
    if (cookie.seconds <= 0 || !matchesPath(cookie.path, biliFeedURL.pathname)) continue
    issued.set(cookie.name, cookie)
  }
  const uid = issued.get("DedeUserID")?.value
  if (!issued.has("SESSDATA") || !uid || !/^\d{1,20}$/u.test(uid) || !issued.has("bili_jct")) return
  return issued
}

export async function lockBiliLogin(redis) {
  const token = crypto.randomUUID()
  if (await redis.set(biliLoginLock, token, { NX: true, EX: 240 }) !== "OK") return
  try {
    const guard = biliFieldKeys(["SESSDATA"])
    const snapshot = (await redis.mGet(guard)).map(value => value ?? "")
    return {
      async replace(issued = new Map()) {
        const platform = platforms.bilibili
        const clear = [...new Set([...guard, ...biliFieldKeys(biliAccountFields)])]
        const values = [...issued.values()]
        const keys = [biliLoginLock, ...clear, ...values.map(({ name, domain }) => keyFor(platform, "." + domain, name))]
        const args = [token, String(guard.length), ...snapshot, String(clear.length)]
        for (const { value, path, seconds } of values) {
          args.push(value, String(Math.min(seconds ?? 15_552_000, 31_536_000)), JSON.stringify({ path, secure: true }))
        }
        return await redis.eval(replaceBiliIdentity, { keys, arguments: args }) === 1
      },
      async close() {
        await redis.eval(releaseBiliLock,
          { keys: [biliLoginLock], arguments: [token] })
      },
    }
  } catch (error) {
    await redis.eval(releaseBiliLock,
      { keys: [biliLoginLock], arguments: [token] }).catch(() => {})
    throw error
  }
}

const clearStoredSession = `
for i = 1, #KEYS do
  if (redis.call('GET', KEYS[i]) or '') ~= ARGV[i] then return 0 end
end
for i = 1, #KEYS do
  redis.call('DEL', KEYS[i], KEYS[i] .. ':meta')
end
return 1`

export function readWeiboLogin(redis, url) {
  return storedSession(redis, platforms.weibo, url)
}

export async function clearWeiboLogin(redis) {
  const platform = platforms.weibo
  const keys = platform.names.flatMap((name) => platform.domains.flatMap((domain) => [
    keyFor(platform, "." + domain, name), keyFor(platform, domain, name),
  ]))
  const current = await redis.mGet(keys)
  if (!current.some(value => value != null)) return "absent"
  const cleared = await redis.eval(clearStoredSession, { keys, arguments: current.map(value => value ?? "") })
  return cleared === 1 ? "cleared" : "changed"
}
