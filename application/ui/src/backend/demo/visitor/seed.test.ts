import { describe, expect, it } from "vitest"

import { visitorSeed } from "./seed"

describe("the visitor's desk", () => {
  const seed = visitorSeed(Date.now())
  const agents = seed.projects.flatMap((project) =>
    project.sessions.flatMap((session) =>
      session.terminals.flatMap((terminal) =>
        terminal.state === "running" && terminal.agent
          ? [{ project: project.id, name: terminal.name, agent: terminal.agent }]
          : [],
      ),
    ),
  )

  it("opens with one agent asking: Claude Code, on its plan", () => {
    expect(agents.filter(({ agent }) => agent.attention)).toEqual([
      expect.objectContaining({
        project: "storefront",
        name: "Checkout implementation",
        agent: expect.objectContaining({ attention: { kind: "plan", count: 1 } }),
      }),
    ])
  })

  it("can open Claude Code on its way to the plan instead, asking nothing yet", () => {
    const reading = visitorSeed(Date.now(), true).projects.flatMap((project) =>
      project.sessions.flatMap((session) => session.terminals),
    )
    const claude = reading.find((terminal) => terminal.name === "Checkout implementation")
    expect(claude).toMatchObject({ agent: { working: true, planning: true } })
    expect(reading.filter((t) => t.state === "running" && t.agent?.attention)).toEqual([])
  })

  it("keeps the other projects at rest, with nothing ended to read", () => {
    for (const { project, agent } of agents.filter((each) => each.project !== "storefront")) {
      expect(agent.working, project).toBe(false)
      expect(agent.lastTurn, project).toBeUndefined()
    }
  })

  it("shows none of the edge states: no subagents, background work or unheard agents", () => {
    for (const { agent } of agents) {
      expect(agent.subagents).toBeUndefined()
      expect(agent.background).toBeUndefined()
    }
    const terminals = seed.projects.flatMap((project) =>
      project.sessions.flatMap((session) => session.terminals),
    )
    expect(terminals.filter((terminal) => terminal.process === "agy")).toEqual([])
  })
})
