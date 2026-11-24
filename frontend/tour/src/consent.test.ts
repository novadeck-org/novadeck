import type { AgentConnection } from "@novadeck/core/port"

import { agentChanged, offerTour, startingTour, tourAgentState, tourFailed } from "./consent"
import { describe, expect, it } from "./test"

const connection = (
  agent: AgentConnection["agent"],
  state: Partial<AgentConnection> = {},
): AgentConnection => ({ agent, available: true, connected: true, busy: false, ...state })

describe("The tour's consent", () => {
  it("is ready where opencode is installed and connected, whatever else is", () => {
    expect(
      tourAgentState([connection("opencode"), connection("claude", { connected: false })]),
    ).toEqual({ step: "ready" })
    expect(tourAgentState([connection("claude")])).toMatchObject({ step: "install" })
  })

  it("offers to install opencode where it isn't, with the installer the backend knows", () => {
    expect(
      tourAgentState([
        connection("opencode", { available: false, connected: false, installer: "curl x | bash" }),
      ]),
    ).toEqual({ step: "install", installer: "curl x | bash" })
    expect(tourAgentState([])).toEqual({ step: "install" })
  })

  it("offers to connect it where it is installed and Novadeck isn't connected, and waits while that is under way", () => {
    expect(tourAgentState([connection("opencode", { connected: false })])).toEqual({
      step: "connect",
    })
    expect(tourAgentState([connection("opencode", { connected: false, busy: true })])).toEqual({
      step: "connecting",
    })
  })

  it("leaves out opencode once its program is gone, though its plugin is still connected", () => {
    expect(tourAgentState([connection("opencode", { available: false })]).step).toBe("install")
  })

  it("says why it couldn't start, starting over clean", () => {
    const starting = startingTour(offerTour())
    expect(starting).toEqual({ starting: true })
    const failed = tourFailed(starting, new Error("You've taken today's free tours."))
    expect(failed).toEqual({ starting: false, error: "You've taken today's free tours." })
    expect(startingTour(failed)).not.toHaveProperty("error")
    expect(tourFailed(starting, "nope").error).toBe("The tour couldn't start.")
  })

  it("is not ready where opencode is older than Novadeck works with, or newer than it knows", () => {
    expect(tourAgentState([connection("opencode", { limited: "outdated" })])).toEqual({
      step: "update",
    })
    expect(tourAgentState([connection("opencode", { limited: "unsupported" })])).toEqual({
      step: "unsupported",
    })
    // What only the status line is limited by doesn't stop the tour.
    expect(tourAgentState([connection("opencode", { limited: "own-status-line" })]).step).toBe(
      "ready",
    )
  })

  it("says why a connect didn't take, until another is tried", () => {
    expect(
      tourAgentState([connection("opencode", { connected: false, error: "Couldn't write it." })]),
    ).toEqual({ step: "connect", error: "Couldn't write it." })
    expect(
      tourAgentState([
        connection("opencode", { connected: false, busy: true, error: "Couldn't write it." }),
      ]),
    ).toEqual({ step: "connecting" })
  })

  it("forgets an error about starting once opencode's state changes, and keeps a start under way", () => {
    const failed = tourFailed(startingTour(offerTour()), new Error("It wasn't connected."))
    expect(agentChanged(failed)).toEqual({ starting: false })
    const starting = startingTour(failed)
    expect(agentChanged(starting)).toBe(starting)
  })
})
