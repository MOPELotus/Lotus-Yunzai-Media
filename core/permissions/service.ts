type Policy = "allow" | "deny" | "inherit" | "master_only"
type Fields = Readonly<Record<string, unknown>>

function fields(value: unknown): Fields {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {}
}

const POLICY_ALLOW = "allow"
const POLICY_DENY = "deny"
const POLICY_INHERIT = "inherit"
const POLICY_MASTER_ONLY = "master_only"

export class PermissionService {
  readonly permissions: ReturnType<typeof normalizePermissions>
  private readonly masters: Set<string>

  constructor({ permissions, masters = [] }: { readonly permissions?: unknown; readonly masters?: readonly (string | number)[] } = {}) {
    this.permissions = normalizePermissions(permissions)
    this.masters = new Set([...masters, ...readRuntimeMasters()].map(String))
  }

  can(subject: unknown, groupIdOrScope?: string | number, scope?: string) {
    return this.explain(subject, groupIdOrScope, scope).ok
  }

  explain(subject: unknown, groupIdOrScope?: string | number, scope?: string) {
    const target = resolvePermissionSubject(subject, groupIdOrScope, scope)
    const user = target.user
    const group = target.group
    const policy = this.permissions.scopes[target.scope]?.policy ?? POLICY_INHERIT

    if (this.permissions.users.deny.has(user)) {
      return deny("user_deny")
    }
    if (group && this.permissions.groups.deny.has(group)) {
      return deny("group_deny")
    }

    if (policy === POLICY_DENY) {
      return deny("scope_deny")
    }
    if (policy === POLICY_MASTER_ONLY) {
      return this.isMaster(target) ? allow("master") : deny("master_only")
    }
    if (policy === POLICY_ALLOW) {
      return allow("scope_allow")
    }

    if (this.permissions.users.allow.has(user)) {
      return allow("user_allow")
    }
    if (group && this.permissions.groups.allow.has(group)) {
      return allow("group_allow")
    }

    return this.permissions.default_policy === POLICY_DENY
      ? deny("default_deny")
      : allow("default_allow")
  }

  isMaster(subject: unknown) {
    const target = resolvePermissionSubject(subject)
    return target.eventIsMaster || this.masters.has(target.user)
  }
}

export function resolvePermissionSubject(subject: unknown, groupIdOrScope: string | number = "", scope = "") {
  const event = fields(subject)
  if (isEventLike(event)) {
    return {
      user: String(event.user_id || event.userId || ""),
      group: event.group_id ? String(event.group_id) : event.groupId ? String(event.groupId) : "",
      scope: scope || String(groupIdOrScope || ""),
      eventIsMaster: isTrue(event.isMaster),
    }
  }

  if ("user" in event) {
    return {
      user: String(event.user || ""),
      group: event.group ? String(event.group) : "",
      scope: event.scope ? String(event.scope) : scope || String(groupIdOrScope || ""),
      eventIsMaster: isTrue(event.eventIsMaster) || isTrue(event.isMaster),
    }
  }

  return {
    user: String(subject || ""),
    group: groupIdOrScope && scope ? String(groupIdOrScope) : "",
    scope: scope || "",
    eventIsMaster: false,
  }
}

export function normalizePermissions(input: unknown = {}) {
  const permissions = fields(input)
  const users = fields(permissions.users), groups = fields(permissions.groups)
  return {
    default_policy: normalizePolicy(permissions.default_policy, POLICY_ALLOW),
    users: {
      allow: toSet(users.allow),
      deny: toSet(users.deny),
    },
    groups: {
      allow: toSet(groups.allow),
      deny: toSet(groups.deny),
    },
    scopes: normalizeScopes(permissions.scopes),
  }
}

export function migrateLegacyPermissionControl(legacy: Fields = {}) {
  const whitelist = [
    ...toArray(legacy.whitelist),
    ...toArray(legacy.whiteList),
    ...toArray(legacy.white_list),
  ]
  const blacklist = [
    ...toArray(legacy.blacklist),
    ...toArray(legacy.blackList),
    ...toArray(legacy.black_list),
  ]
  const mode = String(legacy.mode || "").toLowerCase()

  if (mode.includes("white")) {
    return {
      default_policy: POLICY_DENY,
      users: {
        allow: uniqueStrings(whitelist),
        deny: uniqueStrings(blacklist),
      },
      groups: {
        allow: [],
        deny: [],
      },
      scopes: {},
    }
  }

  return {
    default_policy: mode.includes("deny") ? POLICY_DENY : POLICY_ALLOW,
    users: {
      allow: uniqueStrings(whitelist),
      deny: uniqueStrings(blacklist),
    },
    groups: {
      allow: [],
      deny: [],
    },
    scopes: {},
  }
}

function normalizeScopes(scopes: unknown) {
  const result: Record<string, Fields & { policy: Policy }> = {}
  for (const [scope, value] of Object.entries(fields(scopes))) {
    const rule = fields(value)
    result[scope] = {
      ...rule,
      policy: normalizePolicy(rule?.policy, POLICY_INHERIT),
    }
  }
  return result
}

function normalizePolicy(policy: unknown, fallback: Policy): Policy {
  const value = String(policy || fallback)
  return value === POLICY_ALLOW || value === POLICY_DENY || value === POLICY_INHERIT || value === POLICY_MASTER_ONLY ? value : fallback
}

function readRuntimeMasters() {
  const bot = (globalThis as { Bot?: { config?: Fields; cfg?: Fields } }).Bot
  const config = bot?.config || bot?.cfg || {}
  return [
    ...toArray(config.masterQQ),
    ...toArray(config.master),
    ...toArray(config.master_qq),
  ]
}

function isEventLike(value: Fields) {
  return value && typeof value === "object" && (
    Object.prototype.hasOwnProperty.call(value, "user_id")
    || Object.prototype.hasOwnProperty.call(value, "group_id")
    || Object.prototype.hasOwnProperty.call(value, "isMaster")
  )
}

function isTrue(value: unknown): boolean {
  if (typeof value === "function") {
    try {
      return isTrue(value())
    } catch {
      return false
    }
  }
  return value === true || value === 1 || value === "true"
}

function toSet(value: unknown) {
  return new Set(toArray(value).map(String).filter(Boolean))
}

function toArray(value: unknown): unknown[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function uniqueStrings(values: readonly unknown[]) {
  return [...new Set(toArray(values).map(String).filter(Boolean))]
}

function allow(reason: string) {
  return {
    ok: true,
    reason,
  }
}

function deny(reason: string) {
  return {
    ok: false,
    reason,
  }
}
