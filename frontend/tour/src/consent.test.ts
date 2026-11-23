import type { AgentConnection } from "@novadeck/core/port"

import { offerTour, startingTour, tourAgentState, tourFailed } from "./consent"
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
})
