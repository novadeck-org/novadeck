import { describe, expect, it } from "vitest"

import { factHunks, factsOfAgents } from "./facts"

const main = "import a\n\nexport const x = () => {\n  return 1\n}\n"

describe("an agent's changes as the facts read them", () => {
  it("lays its changes that apply over main, as hunks of both sides", () => {
    const { after, hunks } = factHunks(main, {
      hunks: [
        { at: 4, removed: 1, lines: ["  return 2", "  // two"], applies: true },
        { at: 2, removed: 0, lines: ["import b"], applies: true },
        { at: 1, removed: 1, lines: ["not me"], applies: false },
      ].toSorted((a, b) => a.at - b.at),
    })
    expect(after).toBe("import a\nimport b\n\nexport const x = () => {\n  return 2\n  // two\n}\n")
    expect(
      hunks.map(({ oldStart, oldCount, newStart, newCount }) => [
        oldStart,
        oldCount,
        newStart,
        newCount,
      ]),
    ).toEqual([
      [1, 0, 2, 1],
      [4, 1, 5, 2],
    ])
  })

  it("says where a change sits in a language it parses", async () => {
    const facts = await factsOfAgents("x.ts", main, [
      {
        key: "moth",
        handle: "moth",
        label: "@moth",
        status: "modified",
        changedAt: 1,
        hunks: [{ at: 4, removed: 1, lines: ["  return 2"], applies: true }],
      },
    ])
    expect(facts.get("moth")?.changes[0]?.places).toEqual([
      { kind: "in", declaration: "function", name: "x()" },
    ])
  })
})
