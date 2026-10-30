import { describe, expect, it } from "vitest"

import { build } from "../extract/main.ts"
import { brief, subjects } from "./main.ts"

// Briefs exist to fit in an agent's context: the index stays under 8000 characters and
// every other subject under 6000 (about 1.5k tokens).
describe("brief", () => {
  it("renders every subject within budget", async () => {
    const atlas = await build()
    expect(brief(atlas, undefined).text.length).toBeLessThan(8000)
    const asked = subjects(atlas).map(({ kind, name }) => `${kind}:${name}`)
    const over = asked
      .map((subject) => ({ subject, ...brief(atlas, subject) }))
      .filter(({ found, text }) => !found || text.length > 6000)
      .map(({ subject, text }) => `${subject}: ${text.length}`)
    expect(over).toEqual([])
  }, 30_000)
})
