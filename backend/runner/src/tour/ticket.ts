import { DomainError } from "../errors.js"

/** Where the tour's model service is: Novadeck's website, unless a test or a local run names another. */
export const tourEndpoint = (env: NodeJS.ProcessEnv = process.env): string =>
  (env.NOVADECK_TOUR_ENDPOINT || "https://novadeck.dev/tour/v1").replace(/\/+$/, "")

// What a ticket looks like (novadeck-website's contract): opaque, short, and safe in a config.
const shape = /^[A-Za-z0-9_-]{1,200}$/

const unreachable =
  "Novadeck couldn't reach the tour's service just now, so the tour can't start. Check your connection and try again."

/**
 * A ticket for one run of the tour, from `<endpoint>/tickets`: the tour's agents are paid for by
 * Novadeck, through its website, which hands out a few tickets a day to each person and counts
 * the model calls of each. The ticket is the API key the agents' provider is given.
 *
 * The service refuses with a plain sentence of its own (a person's tickets for the day used, or
 * the free runs switched off: 429 and 503, `{ "error": "..." }`), which is the `CONFLICT`'s
 * message and so what the consent shows. Anything else it answers, or no answer, is a sentence
 * of ours. Nothing is changed by any of them.
 */
export const fetchTicket = async (
  endpoint: string,
  request: typeof fetch = fetch,
): Promise<string> => {
  let response: Response
  try {
    response = await request(`${endpoint}/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new DomainError("CONFLICT", unreachable)
  }
  const body: unknown = await response.json().catch(() => undefined)
  const field = (name: string): unknown =>
    typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined
  if (response.ok) {
    const ticket = field("ticket")
    if (typeof ticket === "string" && shape.test(ticket)) return ticket
    throw new DomainError("CONFLICT", unreachable)
  }
  const said = field("error")
  throw new DomainError(
    "CONFLICT",
    typeof said === "string" && said.trim() !== "" && said.length <= 500
      ? said.trim()
      : unreachable,
  )
}
