import { readdirSync } from "node:fs"
import { join } from "node:path"

import { harnessIds } from "@novadeck/protocol/harnesses"

import { fixtures, type Fixture } from "./fixtures"
import { chatItemsOf, renderChat, type Rendered } from "./pipeline"
import { describe, expect, it } from "./test"

// Real recorded harness transcripts, and hand-written ones in the harnesses' native shapes,
// through every stage to the rendered chat, against goldens that change only with a
// reviewed diff (see the README).

const rendered = new Map<
  Fixture,
  { golden: string; blocks: number; toolRows: number; names: string[]; skipped: string[] }
>()

const run = (fixture: Fixture) => {
  const known = rendered.get(fixture)
  if (known) return known
  const { conversations, skipped } = fixture.extract()
  const results = conversations.map((conversation): [string, Rendered] => [
    conversation.name,
    renderChat(chatItemsOf(fixture.harness, conversation.lines), fixture.harness),
  ])
  const whole = {
    golden: `${results
      .map(([name, { lines }]) => `# ${name}\n${lines.join("\n")}`)
      .join("\n\n")}\n`,
    blocks: results.reduce((sum, [, { lines }]) => sum + lines.length, 0),
    toolRows: results.reduce((sum, [, { toolRows }]) => sum + toolRows, 0),
    names: results.map(([name]) => name),
    skipped,
  }
  rendered.set(fixture, whole)
  return whole
}

describe("the chat, from recorded transcripts", () => {
  for (const fixture of fixtures) {
    it(`renders ${fixture.golden} as its golden`, async () => {
      const { golden, blocks, toolRows } = run(fixture)
      expect(blocks).toBeGreaterThan(0)
      if (fixture.tools) expect(toolRows).toBeGreaterThan(0)
      await expect(golden).toMatchFileSnapshot(`./goldens/${fixture.golden}.txt`)
    })
  }

  it("renders every conversation of a fixture, and skips only the scenarios it names", () => {
    for (const fixture of fixtures) {
      const { names, skipped } = run(fixture)
      expect(names.length, `${fixture.golden} conversations`).toBe(fixture.count)
      expect(new Set(names).size, `${fixture.golden} names`).toBe(names.length)
      expect(skipped.toSorted(), `${fixture.golden} skipped`).toEqual(fixture.skipped.toSorted())
    }
  })

  it("holds tool rows from every harness", () => {
    for (const harness of harnessIds) {
      const rows = fixtures
        .filter((fixture) => fixture.harness === harness)
        .reduce((sum, fixture) => sum + run(fixture).toolRows, 0)
      expect(rows, harness).toBeGreaterThan(0)
    }
  })

  it("keeps a golden for every fixture, and no other", () => {
    const folder = join(import.meta.dirname, "goldens")
    const kept = readdirSync(folder, { recursive: true, encoding: "utf8" })
      .map((file) => file.split("\\").join("/"))
      .filter((file) => file.endsWith(".txt"))
    expect(kept.toSorted()).toEqual(fixtures.map(({ golden }) => `${golden}.txt`).toSorted())
  })
})
