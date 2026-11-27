import { describe, expect, it } from "vitest"

import { NovaTickets, requestTicket, serviceEndpoint, unreachable } from "./ticket.js"

const answering = (status: number, body: unknown, asked: string[] = []): typeof fetch =>
  ((url: string) => {
    asked.push(url)
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    )
  }) as unknown as typeof fetch

describe("a ticket for Novadeck's model service", () => {
  it("is read from the service's answer", async () => {
    await expect(
      requestTicket("http://x/tour/v1", answering(200, { ticket: "abc_DEF-1", expiresAt: "t" })),
    ).resolves.toEqual({ ok: true, ticket: { ticket: "abc_DEF-1", expiresAt: "t" } })
  })

  it("passes on the service's own sentence for a refusal, and none for nonsense", async () => {
    await expect(
      requestTicket("http://x", answering(429, { error: "No free runs today." })),
    ).resolves.toEqual({ ok: false, said: "No free runs today." })
    await expect(
      requestTicket("http://x", answering(200, { ticket: "bad ticket!" })),
    ).resolves.toEqual({ ok: false })
    const down = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch
    await expect(requestTicket("http://x", down)).resolves.toEqual({ ok: false })
  })

  it("is asked of the website unless the environment names another service", () => {
    expect(serviceEndpoint({})).toBe("https://novadeck.dev/tour/v1")
    expect(serviceEndpoint({ NOVADECK_TOUR_ENDPOINT: "http://127.0.0.1:9/tour/v1/" })).toBe(
      "http://127.0.0.1:9/tour/v1",
    )
  })
})

describe("the ticket Novas started by hand share", () => {
  const ends = "2026-11-26T12:00:00.000Z"
  const before = (minutes: number) => Date.parse(ends) - minutes * 60_000

  it("is asked for once, then kept for the Novas after it until near its end", async () => {
    const asked: string[] = []
    let now = before(120)
    const tickets = new NovaTickets({
      endpoint: "http://x/tour/v1",
      request: answering(200, { ticket: "T1", expiresAt: ends }, asked),
      now: () => now,
    })
    const env = { NOVADECK_PI_BASE_URL: "http://x/tour/v1", NOVADECK_PI_KEY: "T1" }
    await expect(tickets.service()).resolves.toEqual({ ok: true, env })
    now = before(20)
    await expect(tickets.service()).resolves.toEqual({ ok: true, env })
    expect(asked).toHaveLength(1)
    // Within its last quarter hour a new one is asked for, so a session has time on it.
    now = before(10)
    await tickets.service()
    expect(asked).toHaveLength(2)
  })

  it("shares one request between Novas starting at once", async () => {
    const asked: string[] = []
    const tickets = new NovaTickets({
      endpoint: "http://x",
      request: answering(200, { ticket: "T1" }, asked),
    })
    await Promise.all([tickets.service(), tickets.service(), tickets.service()])
    expect(asked).toHaveLength(1)
  })

  it("keeps no refusal: says why, and the next start asks again", async () => {
    const asked: string[] = []
    const tickets = new NovaTickets({
      endpoint: "http://x",
      request: answering(429, { error: "You've used today's free runs." }, asked),
    })
    await expect(tickets.service()).resolves.toEqual({
      ok: false,
      reason: "You've used today's free runs.",
    })
    const down = new NovaTickets({
      endpoint: "http://x",
      request: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
    })
    await expect(down.service()).resolves.toEqual({ ok: false, reason: unreachable })
    await tickets.service()
    expect(asked).toHaveLength(2)
  })
})
