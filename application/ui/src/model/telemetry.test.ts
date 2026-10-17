import { describe, expect, it } from "../test"
import { dropContext, dropProject, dropTerminal, noTelemetry, setUsage } from "./telemetry"
import type { AgentUsage } from "./types"

const usage = (occupied: number): AgentUsage => ({
  context: { occupied, capacity: 200_000 },
  limits: [{ minutes: 300, used: 0.4, resetsAt: 10_000 }],
  model: "gpt-6-astra",
  effort: "high",
})

describe("agent telemetry", () => {
  it("holds a terminal's usage under its session", () => {
    expect(setUsage(noTelemetry, "p/s", "1", usage(1))).toEqual({ "p/s": { "1": usage(1) } })
  })

  it("keeps whatever a report does not name as it was", () => {
    const held = setUsage(setUsage(noTelemetry, "p/s", "1", usage(1)), "p/other", "9", usage(9))
    const next = setUsage(held, "p/s", "2", usage(2))
    expect(next["p/other"]).toBe(held["p/other"])
    expect(next["p/s"]!["1"]).toBe(held["p/s"]!["1"])
    expect(next["p/s"]).toEqual({ "1": usage(1), "2": usage(2) })
  })

  it("replaces a terminal's usage when the report differs", () => {
    const held = setUsage(noTelemetry, "p/s", "1", usage(1))
    expect(setUsage(held, "p/s", "1", usage(2))["p/s"]).toEqual({ "1": usage(2) })
  })

  it("changes nothing when a report equals the held usage by value", () => {
    const held = setUsage(noTelemetry, "p/s", "1", usage(1))
    expect(setUsage(held, "p/s", "1", usage(1))).toBe(held)
  })

  it("drops a terminal, and its session once it holds no other", () => {
    const held = setUsage(setUsage(noTelemetry, "p/s", "1", usage(1)), "p/s", "2", usage(2))
    const one = dropTerminal(held, "p/s", "1")
    expect(one).toEqual({ "p/s": { "2": usage(2) } })
    expect(dropTerminal(one, "p/s", "2")).toEqual({})
  })

  it("changes nothing when it drops what it never held", () => {
    const held = setUsage(noTelemetry, "p/s", "1", usage(1))
    expect(dropTerminal(held, "p/s", "2")).toBe(held)
    expect(dropTerminal(held, "p/other", "1")).toBe(held)
    expect(dropContext(held, "p/other")).toBe(held)
  })

  it("drops every session of a project, and no other project's", () => {
    const held = setUsage(
      setUsage(setUsage(noTelemetry, "p/a", "1", usage(1)), "p/b", "2", usage(2)),
      "pp/a",
      "3",
      usage(3),
    )
    const next = dropProject(held, "p")
    expect(next).toEqual({ "pp/a": { "3": usage(3) } })
    expect(next["pp/a"]).toBe(held["pp/a"])
    expect(dropProject(held, "none")).toBe(held)
  })

  it("drops a whole session", () => {
    const held = setUsage(setUsage(noTelemetry, "p/s", "1", usage(1)), "p/o", "2", usage(2))
    const next = dropContext(held, "p/s")
    expect(next).toEqual({ "p/o": { "2": usage(2) } })
    expect(next["p/o"]).toBe(held["p/o"])
  })
})
