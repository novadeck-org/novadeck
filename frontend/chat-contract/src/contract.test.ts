import { fixtures, type Fixture } from "./fixtures"
import { chatItemsOf, renderChat, type Rendered } from "./pipeline"
import { describe, expect, it } from "./test"

// Real recorded harness transcripts, through every stage to the rendered chat, against
// goldens that change only with a reviewed diff (see the README).

const rendered = new Map<Fixture, { golden: string; blocks: number; toolRows: number }>()

const run = (fixture: Fixture) => {
  const known = rendered.get(fixture)
  if (known) return known
  const results = fixture
    .conversations()
    .map((conversation): [string, Rendered] => [
      conversation.name,
      renderChat(chatItemsOf(fixture.transcripts, conversation.lines), fixture.agent),
    ])
  const whole = {
    golden: `${results
      .map(([name, { lines }]) => `# ${name}\n${lines.join("\n")}`)
      .join("\n\n")}\n`,
    blocks: results.reduce((sum, [, { lines }]) => sum + lines.length, 0),
    toolRows: results.reduce((sum, [, { toolRows }]) => sum + toolRows, 0),
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

  it("shows every conversation of a fixture, not just the first", () => {
    for (const fixture of fixtures) {
      const { golden } = run(fixture)
      expect(golden.match(/^# /gm)?.length).toBe(fixture.conversations().length)
    }
  })

  it("holds tool rows from every harness", () => {
    for (const harness of ["claude", "codex", "agy"] as const) {
      const rows = fixtures
        .filter((fixture) => fixture.harness === harness)
        .reduce((sum, fixture) => sum + run(fixture).toolRows, 0)
      expect(rows, harness).toBeGreaterThan(0)
    }
  })
})
