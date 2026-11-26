import { tourEnv } from "./launch.js"
import { describe, expect, it } from "./test.js"
import { fetchTicket, tourEndpoint } from "./ticket.js"

const answering = (status: number, body: unknown): typeof fetch =>
  (() =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    )) as typeof fetch

describe("the tour's terminals' environment", () => {
  it("names the service's address and the ticket, in the variables Novadeck's pi reads", () => {
    expect(tourEnv("https://novadeck.dev/tour/v1", "T-1")).toEqual({
      NOVADECK_PI_BASE_URL: "https://novadeck.dev/tour/v1",
      NOVADECK_PI_KEY: "T-1",
    })
  })
})

describe("the tour's ticket", () => {
  it("is read from the service's answer", async () => {
    await expect(
      fetchTicket("http://x/tour/v1", answering(200, { ticket: "abc_DEF-1", expiresAt: "t" })),
    ).resolves.toEqual({ ticket: "abc_DEF-1", expiresAt: "t" })
  })

  it("asks at /tickets of the endpoint, which the environment may name", async () => {
    const urls: string[] = []
    const request = ((url: string) => (
      urls.push(url),
      Promise.resolve(new Response('{"ticket":"t"}'))
    )) as unknown as typeof fetch
    await fetchTicket(
      tourEndpoint({ NOVADECK_TOUR_ENDPOINT: "http://127.0.0.1:9/tour/v1/" }),
      request,
    )
    expect(urls).toEqual(["http://127.0.0.1:9/tour/v1/tickets"])
    expect(tourEndpoint({})).toBe("https://novadeck.dev/tour/v1")
  })

  it.each([429, 503])("passes on the service's own sentence for a %i", async (status) => {
    await expect(
      fetchTicket("http://x", answering(status, { error: "No free runs today." })),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "No free runs today." })
  })

  it("says it couldn't reach the service where it didn't answer, or answered nonsense", async () => {
    const down = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch
    await expect(fetchTicket("http://x", down)).rejects.toThrow("couldn't reach")
    await expect(
      fetchTicket("http://x", answering(200, { ticket: "bad ticket!" })),
    ).rejects.toThrow("couldn't reach")
    await expect(fetchTicket("http://x", answering(500, "<html>"))).rejects.toThrow(
      "couldn't reach",
    )
  })
})
