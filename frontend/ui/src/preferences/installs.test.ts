import type { AgentConnection, Backend } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import { describe, expect, it } from "vitest"

import { connectInstalled, stepInstall, type PendingInstall } from "./installs"

const pending: PendingInstall = { agent: "claude", terminalId: "03", ran: false }

describe("an install's terminal", () => {
  it("is not over before the installer was seen working", () => {
    expect(stepInstall(pending, { busy: false, directory: "~/app" })).toEqual({
      step: "running",
      install: pending,
    })
  })

  it("is seen working once it is busy, and over once it is not any more", () => {
    const working = stepInstall(pending, { busy: true, directory: "~/app" })
    expect(working).toEqual({ step: "running", install: { ...pending, ran: true } })
    const install = working.step === "running" ? working.install : pending
    expect(stepInstall(install, { busy: true, directory: "~/app" })).toEqual(working)
    expect(stepInstall(install, { busy: false, directory: "~/app" })).toEqual({ step: "finished" })
  })

  it("is over without a result when its terminal closed", () => {
    expect(stepInstall(pending, undefined)).toEqual({ step: "gone" })
    expect(stepInstall({ ...pending, ran: true }, undefined)).toEqual({ step: "gone" })
  })
})

// An agents backend that shows what a refresh finds, and connects after a moment.
const agentsBackend = (
  found: readonly AgentConnection[],
  connecting: "works" | "fails" = "works",
) => {
  const state = createStore<readonly AgentConnection[]>([
    { agent: "claude", available: false, connected: false, busy: false },
  ])
  const sets: [string, boolean][] = []
  const agents: NonNullable<Backend["agents"]> = {
    state,
    set: (agent, connected) => {
      sets.push([agent, connected])
      state.update((list) => list.map((item) => ({ ...item, busy: true })))
      setTimeout(
        () =>
          state.update((list) =>
            list.map((item) => ({
              ...item,
              busy: false,
              ...(connecting === "works" ? { connected } : { error: "denied" }),
            })),
          ),
        0,
      )
    },
    refresh: () => {
      state.update(() => found)
      return Promise.resolve()
    },
    welcome: createStore(false),
    finishWelcome: () => {},
  }
  return { agents, sets }
}

describe("a finished install", () => {
  it("connects the agent it installed, and is ready once connected", async () => {
    const { agents, sets } = agentsBackend([
      { agent: "claude", available: true, connected: false, busy: false },
    ])
    expect(await connectInstalled(agents, "claude")).toBe("ready")
    expect(sets).toEqual([["claude", true]])
  })

  it("leaves an agent that is still not installed alone, as its installer failed", async () => {
    const { agents, sets } = agentsBackend([
      { agent: "claude", available: false, connected: false, busy: false },
    ])
    expect(await connectInstalled(agents, "claude")).toBe("missing")
    expect(sets).toEqual([])
  })

  it("does not connect an agent that is connected already", async () => {
    const { agents, sets } = agentsBackend([
      { agent: "claude", available: true, connected: true, busy: false },
    ])
    expect(await connectInstalled(agents, "claude")).toBe("ready")
    expect(sets).toEqual([])
  })

  it("says so where connecting failed, which the agent's switch shows", async () => {
    const { agents } = agentsBackend(
      [{ agent: "claude", available: true, connected: false, busy: false }],
      "fails",
    )
    expect(await connectInstalled(agents, "claude")).toBe("unconnected")
    expect(agents.state.getSnapshot()[0]).toMatchObject({ error: "denied" })
  })
})
