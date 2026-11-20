import { TourNeedsAgent, type AgentConnection } from "@novadeck/core/port"

import {
  chooseAgent,
  connectingAgent,
  followAgents,
  offerTour,
  startingTour,
  tourAgents,
  tourFailed,
} from "./consent"
import { context, describe, expect, it } from "./test"

const connection = (
  agent: AgentConnection["agent"],
  state: Partial<AgentConnection> = {},
): AgentConnection => ({ agent, available: true, connected: true, busy: false, ...state })

describe("The tour's consent", () => {
  it("offers the connected agents in Novadeck's order", () => {
    const connections = [
      connection("agy"),
      connection("codex", { connected: false }),
      connection("claude"),
    ]
    expect(tourAgents(connections)).toEqual(["claude", "agy"])
    expect(offerTour(connections)).toEqual({ agent: "claude", starting: false })
  })

  it("leaves out an agent still connected once its program is gone", () => {
    const connections = [connection("claude"), connection("codex", { available: false })]
    expect(tourAgents(connections)).toEqual(["claude"])
    expect(offerTour(connections, "codex")).toEqual({
      agent: "claude",
      starting: false,
      preferred: "codex",
    })
  })

  it("opens on the agent asked for where it can run the tour", () => {
    const connections = [connection("claude"), connection("codex")]
    expect(offerTour(connections, "codex")).toMatchObject({ agent: "codex" })
  })

  it("offers an agent while it is being connected, and waits for it to start", () => {
    const connections = [connection("codex", { connected: false, busy: true })]
    expect(offerTour(connections, "codex")).toMatchObject({ agent: "codex" })
    expect(connectingAgent(connections, "codex")).toBe(true)
    expect(connectingAgent([connection("codex")], "codex")).toBe(false)
  })

  it("has no agent where none is connected, nor installed and being connected", () => {
    const connections = [
      connection("claude", { connected: false }),
      connection("agy", { available: false, connected: false, busy: true }),
    ]
    expect(offerTour(connections)).toEqual({ agent: null, starting: false })
  })

  context("as the connections change while it is open", () => {
    it("takes the agent it was offered on once that one shows", () => {
      const offered = offerTour([], "codex")
      expect(offered.agent).toBeNull()
      const shown = followAgents(offered, [connection("claude"), connection("codex")])
      expect(shown.agent).toBe("codex")
    })

    it("moves off an agent that was disconnected", () => {
      const offered = offerTour([connection("claude"), connection("codex")], "claude")
      const after = followAgents(chooseAgent(offered, "claude"), [connection("codex")])
      expect(after.agent).toBe("codex")
    })

    it("keeps the agent it is starting with, whatever connects or goes", () => {
      const starting = startingTour(offerTour([connection("claude")]))
      expect(followAgents(starting, [connection("codex")])).toBe(starting)
    })

    it("stays the same consent where nothing it shows changed", () => {
      const offered = offerTour([connection("claude")])
      expect(followAgents(offered, [connection("claude"), connection("agy")])).toBe(offered)
    })
  })

  it("keeps the agent while it starts, and says why it couldn't, starting over clean", () => {
    const starting = startingTour(offerTour([connection("claude")]))
    expect(chooseAgent(starting, "agy")).toBe(starting)
    const failed = tourFailed(starting, new Error("The folder isn't Novadeck's."))
    expect(failed).toMatchObject({
      agent: "claude",
      starting: false,
      error: "The folder isn't Novadeck's.",
    })
    expect(startingTour(failed)).not.toHaveProperty("error")
    expect(tourFailed(starting, "nope").error).toBe("The tour couldn't start.")
  })

  it("names the agent to start first where that is why it couldn't, until it starts again", () => {
    const starting = startingTour(offerTour([connection("codex")]))
    const failed = tourFailed(
      starting,
      new TourNeedsAgent("Codex hasn't listed its models.", "codex"),
    )
    expect(failed).toMatchObject({ needs: "codex", error: "Codex hasn't listed its models." })
    expect(startingTour(failed)).not.toHaveProperty("needs")
  })
})
