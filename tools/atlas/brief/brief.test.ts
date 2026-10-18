import { describe, expect, it } from "vitest"

import { build } from "../extract/main.ts"
import { brief } from "./main.ts"

// Briefs exist to fit in an agent's context: the index stays under 8000 characters and
// every other subject under 6000 (about 1.5k tokens).
describe("brief", () => {
  it("renders every subject within budget", async () => {
    const atlas = await build()
    expect(brief(atlas, undefined).text.length).toBeLessThan(8000)
    const subjects = [
      "api",
      "data",
      "state",
      "flows",
      "harnesses",
      ...atlas.areas.map((a) => `area:${a.id}`),
      ...atlas.api.procedures.map((p) => `procedure:${p.id}`),
      ...atlas.ui.actions.map((a) => `action:${a.type}`),
      ...atlas.data.tables.map((t) => `table:${t.name}`),
      ...atlas.agents.tools.map((t) => `tool:${t.name}`),
      ...atlas.flows.map((f) => `flow:${f.id}`),
    ]
    const over = subjects
      .map((subject) => ({ subject, ...brief(atlas, subject) }))
      .filter(({ found, text }) => !found || text.length > 6000)
      .map(({ subject, text }) => `${subject}: ${text.length}`)
    expect(over).toEqual([])
  }, 30_000)
})
