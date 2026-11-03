import { shapes as agy } from "@novadeck/harness-agy/shapes"
import { shapes as claude } from "@novadeck/harness-claude/shapes"
import { shapes as codex } from "@novadeck/harness-codex/shapes"
import type { Shape } from "@novadeck/harness-core/shapes"
import type { AgentName } from "@novadeck/protocol/harnesses"

import { fixtures } from "./fixtures"
import { transcriptsOf } from "./pipeline"
import { describe, expect, it } from "./test"

// Each decoder's shape lists against every recorded fixture and vocabulary conversation of
// its harness: every shape they hold is on a list, and the lists say what the decoder does.

const shapesOf: Readonly<Record<AgentName, (line: string) => readonly Shape[]>> = {
  claude,
  codex,
  agy,
}

// The keys of the person's own words, each harness's.
const personKeys: Readonly<Record<AgentName, readonly string[]>> = {
  claude: [
    "block:user/text",
    "attachment:queued_command/human/prompt",
    "attachment:queued_command/human/none",
  ],
  codex: ["item:message/user"],
  agy: ["step:USER_EXPLICIT/USER_INPUT"],
}

// What a slash command printed, which shows nothing when it printed nothing.
const mayBeSilent: ReadonlySet<string> = new Set([
  "tag:local-command-stdout",
  "tag:local-command-stderr",
])

describe("transcript shapes", () => {
  for (const fixture of fixtures) {
    const lines = fixture.extract().conversations.flatMap((conversation) => conversation.lines)
    const shapes = shapesOf[fixture.harness]

    it(`classifies every shape in ${fixture.golden}`, () => {
      const unknown = [
        ...new Set(
          lines.flatMap((line) =>
            shapes(line)
              .filter((shape) => shape.verdict === "unknown")
              .map((shape) => shape.key),
          ),
        ),
      ]
      expect(unknown).toEqual([])
    })

    it(`agrees with the decoder in ${fixture.golden}`, () => {
      const decode = transcriptsOf[fixture.harness].items
      // A line that decodes to something holds a shape that is read; and a line of the
      // person's words that no skipped shape covers decodes to something, so a prompt can't
      // vanish under a key that says it is read, as #482's did.
      const disagreeing = lines.flatMap((line) => {
        const held = shapes(line)
        const read = held.some((shape) => shape.verdict === "read")
        // Only a skipped tag says the person's text is no words of theirs.
        const skipped = held.some(
          (shape) => shape.verdict === "skipped" && shape.key.startsWith("tag:"),
        )
        const person = held.some((shape) => personKeys[fixture.harness].includes(shape.key))
        const silent = held.some((shape) => mayBeSilent.has(shape.key))
        const items = decode(line).length
        if (items > 0 && !read) return [`decoded with no read shape: ${line}`]
        if (items === 0 && person && !skipped && !silent)
          return [`read but decoded to nothing: ${line}`]
        return []
      })
      expect(disagreeing).toEqual([])
    })
  }
})
