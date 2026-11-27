import { ownService } from "./model.js"

// Nova's free model: Novadeck's model service on its website (novadeck-website's src/tour) hands
// out tickets, a few a day to each person, each good for some hours and a number of model calls,
// and a ticket is the key Nova's provider takes (`model.ts`). The tour takes one per run; a Nova
// started by hand takes one too (`NovaTickets`), kept for as long as it is good.

/** Where the model service is: Novadeck's website, unless a test or a local run names another. */
export const serviceEndpoint = (env: NodeJS.ProcessEnv = process.env): string =>
  (env.NOVADECK_TOUR_ENDPOINT || "https://novadeck.dev/tour/v1").replace(/\/+$/, "")

// What a ticket looks like (novadeck-website's contract): opaque, short, and safe in a config.
const shape = /^[A-Za-z0-9_-]{1,200}$/

/** A ticket, with when it stops working where the service says (an ISO time). */
export type Ticket = { readonly ticket: string; readonly expiresAt?: string | undefined }

/**
 * What the service answered: a ticket, or its refusal, with its own plain sentence where it gave
 * one (a person's tickets for the day used, or the free runs switched off: 429 and 503,
 * `{ "error": "..." }`); none where it didn't answer, or answered nonsense.
 */
export type TicketAnswer =
  | { readonly ok: true; readonly ticket: Ticket }
  | { readonly ok: false; readonly said?: string | undefined }

/** Asks `<endpoint>/tickets` for a ticket. Never throws. */
export const requestTicket = async (
  endpoint: string,
  request: typeof fetch = fetch,
): Promise<TicketAnswer> => {
  let response: Response
  try {
    response = await request(`${endpoint}/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return { ok: false }
  }
  const body: unknown = await response.json().catch(() => undefined)
  const field = (name: string): unknown =>
    typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined
  if (response.ok) {
    const ticket = field("ticket")
    const expires = field("expiresAt")
    return typeof ticket === "string" && shape.test(ticket)
      ? { ok: true, ticket: { ticket, ...(typeof expires === "string" && { expiresAt: expires }) } }
      : { ok: false }
  }
  const said = field("error")
  return {
    ok: false,
    ...(typeof said === "string" &&
      said.trim() !== "" &&
      said.length <= 500 && { said: said.trim() }),
  }
}

/** The variables a terminal of Nova's is given the service in, for `ticket`. */
export const serviceEnv = (endpoint: string, ticket: string): Readonly<Record<string, string>> => ({
  [ownService.baseUrl]: endpoint,
  [ownService.key]: ticket,
})

// How long before a ticket's end it stops being handed out, so a session started on it has time;
// and how long one the service gave no end for is kept (its tickets last 3 hours).
const marginMs = 15 * 60_000
const keptMs = 2 * 60 * 60_000

/** What a Nova started by hand gets: the service's variables, or why it has none. */
export type NovaService =
  | { readonly ok: true; readonly env: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string }

/** What a Nova started without Novadeck's model is told, before the service's reason. */
export const noFreeModel = "Nova starts without Novadeck's free model:"

/** Why a Nova has no free model where the service said nothing of its own. */
export const unreachable = "Novadeck's model service didn't answer. Check your connection."

/**
 * The ticket a runner's Novas started by hand share: asked for at the first one, and kept for
 * those after it until it is near its end, so starting Nova again spends none of the day's
 * tickets. Asks made at once share one request. A refusal isn't kept: the next start asks again.
 */
export class NovaTickets {
  private kept: { readonly ticket: string; readonly until: number } | undefined
  private asking: Promise<NovaService> | undefined

  constructor(
    private readonly options: {
      readonly endpoint?: string
      readonly request?: typeof fetch
      readonly now?: () => number
    } = {},
  ) {}

  /** The service's variables for a Nova starting now, with the ticket kept or a new one. */
  service(): Promise<NovaService> {
    const now = (this.options.now ?? Date.now)()
    const endpoint = this.options.endpoint ?? serviceEndpoint()
    if (this.kept && this.kept.until > now)
      return Promise.resolve({ ok: true, env: serviceEnv(endpoint, this.kept.ticket) })
    this.asking ??= (async (): Promise<NovaService> => {
      const answer = await requestTicket(endpoint, this.options.request)
      if (!answer.ok) return { ok: false, reason: answer.said ?? unreachable }
      const ends = Date.parse(answer.ticket.expiresAt ?? "")
      this.kept = {
        ticket: answer.ticket.ticket,
        until: Number.isFinite(ends) ? ends - marginMs : now + keptMs,
      }
      return { ok: true, env: serviceEnv(endpoint, answer.ticket.ticket) }
    })().finally(() => {
      this.asking = undefined
    })
    return this.asking
  }
}
