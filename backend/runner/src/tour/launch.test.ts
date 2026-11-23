import { commandWords } from "../terminals/commands.js"
import { describe, expect, it } from "../test.js"
import { tourConfig, tourLaunch } from "./launch.js"
import { fetchTicket, tourEndpoint } from "./ticket.js"

const answering = (status: number, body: unknown): typeof fetch =>
  (() =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    )) as typeof fetch

describe("the tour's launch line", () => {
  it("starts opencode on GPT-6 Luna at medium, in its build agent, with no prompt", () => {
    const launch = tourLaunch()
    expect(launch).toMatchObject({ brief: "doorbell", model: "openrouter/openai/gpt-6-luna" })
    expect(commandWords(launch.command, "linux")).toEqual([
      "opencode",
      "--model",
      "openrouter/openai/gpt-6-luna",
      "--variant",
      "medium",
      "--agent",
      "build",
    ])
  })

  it("reads the same in Windows' shells", () => {
    expect(commandWords(tourLaunch().command, "win32").at(-1)).toBe("build")
  })
})

describe("the tour's opencode configuration", () => {
  it("names the provider's address and the ticket, the model for titles too, and the effort as the agents' variant", () => {
    const config = JSON.parse(tourConfig("https://novadeck.dev/tour/v1", "T-1"))
    expect(config.provider.openrouter.options).toEqual({
      baseURL: "https://novadeck.dev/tour/v1",
      apiKey: "T-1",
    })
    expect(config).toMatchObject({
      model: "openrouter/openai/gpt-6-luna",
      small_model: "openrouter/openai/gpt-6-luna",
      enabled_providers: ["openrouter"],
      disabled_providers: [],
    })
    expect(config.agent.build).toEqual({ model: "openrouter/openai/gpt-6-luna", variant: "medium" })
  })
})

describe("the tour's ticket", () => {
  it("is read from the service's answer", async () => {
    await expect(
      fetchTicket("http://x/tour/v1", answering(200, { ticket: "abc_DEF-1", expiresAt: "t" })),
    ).resolves.toBe("abc_DEF-1")
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
