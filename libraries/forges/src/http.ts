import type { Fetch, Problem } from "./forge.js"

/** What a request came to: a parsed body, a Problem, or nothing there (404). */
export type Answer =
  | { readonly body: unknown }
  | { readonly problem: Problem }
  | { readonly absent: true }

const minute = 60_000

/** When a rate-limited answer says to try again, in epoch milliseconds (a minute on if it doesn't say). */
const until = (headers: Headers, now: number): number => {
  const after = Number(headers.get("retry-after"))
  if (headers.get("retry-after") !== null && Number.isFinite(after)) return now + after * 1000
  const reset = Number(headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset"))
  if (Number.isFinite(reset) && reset > 0) return reset * 1000
  return now + minute
}

const limitedBy403 = (headers: Headers): boolean =>
  headers.get("retry-after") !== null ||
  headers.get("x-ratelimit-remaining") === "0" ||
  headers.get("ratelimit-remaining") === "0"

/** A failing status as a Problem; undefined for a 404, which is no answer rather than a failure. */
export const problemOf = (
  response: Response,
  fixes: { readonly signIn: string; readonly refused?: string | undefined },
  now: number = Date.now(),
): Problem | undefined => {
  const { status, headers } = response
  if (status === 404) return undefined
  if (status === 401 || status === 203 || (status >= 300 && status < 400))
    return { kind: "signed-out", fix: fixes.signIn }
  if (status === 429) return { kind: "limited", until: until(headers, now) }
  if (status === 403) {
    if (limitedBy403(headers)) return { kind: "limited", until: until(headers, now) }
    return { kind: "refused", fix: fixes.refused }
  }
  if (status >= 500) return { kind: "unreachable" }
  return { kind: "unknown", said: `HTTP ${status}` }
}

/** One request through the injected fetch, its failure statuses mapped. */
export const send = async (
  fetch: Fetch,
  url: string,
  init: RequestInit,
  fixes: { readonly signIn: string; readonly refused?: string | undefined },
): Promise<Answer> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    return { problem: { kind: "unreachable" } }
  }
  // Azure DevOps answers an expired token with a 203 sign-in page.
  if (!response.ok || response.status === 203) {
    const problem = problemOf(response, fixes)
    return problem === undefined ? { absent: true } : { problem }
  }
  try {
    return { body: await response.json() }
  } catch {
    return { problem: { kind: "unknown", said: "the answer was not JSON" } }
  }
}

export const headers = (token: string): Record<string, string> => ({
  accept: "application/json",
  authorization: `Bearer ${token}`,
  "user-agent": "forges",
})

export const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** Runs `work` on each item, a few at a time. */
export const pooled = async <T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  size = 6,
): Promise<R[]> => {
  const out: R[] = []
  for (let at = 0; at < items.length; at += size) {
    // eslint-disable-next-line no-await-in-loop -- A few at a time, by design.
    out.push(...(await Promise.all(items.slice(at, at + size).map(work))))
  }
  return out
}
