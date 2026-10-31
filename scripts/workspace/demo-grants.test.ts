import { describe, expect, it } from "vitest"

import {
  demoEndingGrant,
  demoInboxRowsAll,
  demoLiveGrant,
} from "../../frontend/demo/src/inbox/fixtures.ts"
import { refusesCommand } from "../../harnesses/core/src/grants/commands.ts"

// The demo shows the commands a Grant card or an approval would let an agent run. The runner
// refuses some (a program that runs other code, `rest` on git or gh), so the demo may not show
// one: a person would be offered what the real app never grants. The demo can't import the
// matcher (it is not a dependency of the demo), so this walk holds it to the matcher's word.

type Found = { readonly argv: readonly string[]; readonly rest: boolean }

// Every `{ argv, rest }` anywhere in the value: proposals, approval asks and grants alike.
const commandsIn = (value: unknown): Found[] => {
  if (Array.isArray(value)) return value.flatMap(commandsIn)
  if (typeof value !== "object" || value === null) return []
  const fields = value as Record<string, unknown>
  const own =
    Array.isArray(fields.argv) && typeof fields.rest === "boolean"
      ? [fields as unknown as Found]
      : []
  return [...own, ...Object.values(fields).flatMap(commandsIn)]
}

describe("the demo's grant commands", () => {
  it("are all commands the matcher accepts", () => {
    const now = Date.UTC(2026, 9, 31)
    const found = commandsIn([
      demoInboxRowsAll(now),
      demoLiveGrant(now),
      demoEndingGrant(now, 60_000),
    ])
    // Proposals, an approval ask and both grants each hold some, so the walk finds its marks.
    expect(found.length).toBeGreaterThanOrEqual(8)
    for (const command of found)
      expect([command.argv.join(" "), refusesCommand(command)]).toEqual([
        command.argv.join(" "),
        undefined,
      ])
  })
})
