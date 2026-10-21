import type { SourceProject } from "@novadeck/core/source"

import { context, describe, expect, it } from "../test"
import {
  dimmedBy,
  litSet,
  namedAgents,
  stripItems,
  toggleAgent,
  toggleSquad,
  workingAgents,
} from "./source-agents"

const project = (parts: Partial<SourceProject> = {}): SourceProject => ({
  entries: [],
  ignored: [],
  changes: {
    "a.ts": { kind: "modified", touched: { moth: 2, crow: 1 } },
    "b.ts": { kind: "added", touched: { wren: 3 } },
  },
  writing: { kite: "c.ts" },
  ...parts,
})

describe("The agents with work here", () => {
  it("are those who touched a change or are writing a file", () => {
    expect([...workingAgents(project())].toSorted()).toEqual(["crow", "kite", "moth", "wren"])
  })

  it("are nobody before a first change", () => {
    expect(workingAgents(project({ changes: {}, writing: {} })).size).toBe(0)
  })
})

describe("The strip's items", () => {
  const roster = ["wren", "moth", "owl", "crow"]

  it("follow the roster, with handles of no terminal after them alphabetically", () => {
    const items = stripItems(project({ writing: { kite: "c.ts", ash: "d.ts" } }), roster, [])

    expect(items.map((item) => item.kind === "solo" && item.handle)).toEqual([
      "wren",
      "moth",
      "crow",
      "ash",
      "kite",
    ])
  })

  it("leave out agents with no work, even when a terminal has them", () => {
    expect(stripItems(project(), ["owl"], [])).not.toContainEqual({ kind: "solo", handle: "owl" })
  })

  it("group a team's members with work in one squad, the lead first, where the first sits", () => {
    const items = stripItems(project(), roster, [["moth", "owl", "crow"]])

    expect(items).toEqual([
      { kind: "solo", handle: "wren" },
      { kind: "squad", members: ["moth", "crow"] },
      { kind: "solo", handle: "kite" },
    ])
  })

  it("make no squad of a team with fewer than two members with work", () => {
    expect(stripItems(project(), roster, [["moth", "owl"]])).toEqual([
      { kind: "solo", handle: "wren" },
      { kind: "solo", handle: "moth" },
      { kind: "solo", handle: "crow" },
      { kind: "solo", handle: "kite" },
    ])
  })

  it("keep an agent in the first squad that names it", () => {
    const items = stripItems(project(), roster, [
      ["moth", "crow"],
      ["crow", "wren"],
    ])

    expect(items.filter((item) => item.kind === "squad")).toEqual([
      { kind: "squad", members: ["moth", "crow"] },
    ])
  })
})

describe("Toggling the kept set", () => {
  it("keeps an agent, and releases it on the next toggle", () => {
    const kept = toggleAgent(new Set(), "moth")

    expect([...kept]).toEqual(["moth"])
    expect(toggleAgent(kept, "moth").size).toBe(0)
  })

  it("toggles a squad whole: all kept unless every member already is", () => {
    const members = ["moth", "crow"]

    expect([...toggleSquad(new Set(), members)]).toEqual(["moth", "crow"])
    expect([...toggleSquad(new Set(["crow"]), members)].toSorted()).toEqual(["crow", "moth"])
    expect([...toggleSquad(new Set(["moth", "crow", "wren"]), members)]).toEqual(["wren"])
  })
})

describe("The lit set", () => {
  context("when someone is kept", () => {
    it("is the kept set, whatever terminal is selected", () => {
      expect([...litSet(project(), new Set(["moth", "wren"]), "crow")]).toEqual(["moth", "wren"])
    })
  })

  context("when nobody is kept", () => {
    it("is the selected terminal's agent when it has work here", () => {
      expect([...litSet(project(), new Set(), "crow")]).toEqual(["crow"])
    })

    it("is nobody for an agent with no work, no selection or no project", () => {
      expect(litSet(project(), new Set(), "owl").size).toBe(0)
      expect(litSet(project(), new Set(), undefined).size).toBe(0)
      expect(litSet(undefined, new Set(), "moth").size).toBe(0)
    })
  })
})

describe("Dimming by a set", () => {
  const node = { touched: { moth: 1 }, writing: ["crow"] }

  it("dims what none of the lit agents touched", () => {
    expect(dimmedBy(node, new Set(["wren", "kite"]))).toBe(true)
  })

  it("keeps what any lit agent touched or is writing", () => {
    expect(dimmedBy(node, new Set(["wren", "moth"]))).toBe(false)
    expect(dimmedBy(node, new Set(["crow"]))).toBe(false)
  })

  it("dims nothing while nobody is lit", () => {
    expect(dimmedBy(node, new Set())).toBe(false)
  })
})

describe("Naming agents", () => {
  it("reads as a short list", () => {
    expect(namedAgents(["moth"])).toBe("@moth")
    expect(namedAgents(["moth", "crow"])).toBe("@moth and @crow")
    expect(namedAgents(["a", "b", "c"])).toBe("@a, @b and @c")
  })
})
