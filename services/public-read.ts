import { withoutReadRetries, withReadRetries, type ReadTransport } from "@lotus-yunzai/http"

type PublicReadInit = Omit<RequestInit, "headers" | "signal"> & {
  readonly headers?: Record<string, string>
  readonly signal?: AbortSignal
}
type PublicFetch = (url: string, init?: PublicReadInit) => Promise<Response>
const readers = new WeakMap<PublicFetch, Map<number, ReadTransport>>()

/** Bounded GET/HEAD transport for already validated public pages and artwork. */
export function readPublicResponse(fetch: PublicFetch, input: string | URL, init: RequestInit = {}, attempts: 1 | 2 | 3 = 3) {
  let policies = readers.get(fetch)
  if (!policies) { policies = new Map(); readers.set(fetch, policies) }
  let request = policies.get(attempts)
  if (!request) {
    request = withReadRetries((target, options) => {
      const { headers, signal, ...outgoing } = options
      const fields = headers instanceof Headers || Array.isArray(headers)
        ? Object.fromEntries(new Headers(headers)) : headers
      return withoutReadRetries(() => fetch(target.href, {
        ...outgoing, ...(fields && { headers: fields }), signal: signal ?? undefined,
      }))
    }, { attempts })
    policies.set(attempts, request)
  }
  return request(new URL(input), init)
}
