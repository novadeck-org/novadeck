import { agentChanged, offerTour, startingTour, tourAgentNote, tourFailed } from "./consent"
import { describe, expect, it } from "./test"

describe("The tour's consent", () => {
  it("waits for Pi while its download isn't asked for yet or is under way", () => {
    expect(tourAgentNote({ state: "off" })).toEqual({ step: "waiting", text: "Downloading Pi…" })
    expect(tourAgentNote({ state: "downloading" })).toEqual({
      step: "waiting",
      text: "Downloading Pi…",
    })
  })

  it("says how far the download is, in megabytes, where the runner knows its size", () => {
    expect(tourAgentNote({ state: "downloading", received: 12_345_678, size: 58_100_000 })).toEqual(
      { step: "waiting", text: "Downloading Pi: 12.3 of 58.1 MB" },
    )
  })

  it("is ready once Pi is in place", () => {
    expect(tourAgentNote({ state: "ready" })).toEqual({ step: "ready" })
  })

  it("says why a download failed, in the runner's words", () => {
    expect(tourAgentNote({ state: "failed", error: "No network." })).toEqual({
      step: "failed",
      text: "No network.",
    })
    expect(tourAgentNote({ state: "failed" }).text).toBe("Pi's download failed.")
  })

  it("says why it couldn't start, starting over clean", () => {
    const starting = startingTour(offerTour())
    expect(starting).toEqual({ starting: true })
    const failed = tourFailed(starting, new Error("You've taken today's free tours."))
    expect(failed).toEqual({ starting: false, error: "You've taken today's free tours." })
    expect(startingTour(failed)).not.toHaveProperty("error")
    expect(tourFailed(starting, "nope").error).toBe("The tour couldn't start.")
  })

  it("forgets an error about starting once Pi's state changes, and keeps a start under way", () => {
    const failed = tourFailed(startingTour(offerTour()), new Error("Its download failed."))
    expect(agentChanged(failed)).toEqual({ starting: false })
    const starting = startingTour(failed)
    expect(agentChanged(starting)).toBe(starting)
  })
})
