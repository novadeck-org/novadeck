import { interruptionEntry } from "@novadeck/harness-core/items"

import { chatItemsFrom, chatItemsOf, renderChat, transcriptsOf } from "./pipeline"
import { describe, expect, it } from "./test"

// Antigravity's transcript records no step for the person's Escape, so the runner joins an
// interruption of its own to its items where the Escape came (backend/runner's
// `transcriptChanges`). It reads in the chat as Claude Code's own record of one does.

const step = (fields: object): string =>
  JSON.stringify({ created_at: "2026-10-11T17:09:15Z", ...fields })

// An Escape between a response's words and the tool call after them, as the probe captured
// it: the words written just after the key, the runner's note after them, then the person's
// next prompt (see backend/runner's manager test).
const agy = [
  step({
    step_index: 0,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: "<USER_REQUEST>\nCheck the folder\n</USER_REQUEST>",
  }),
  step({
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    content: "Let me check the folder.",
  }),
]
const next = step({
  step_index: 2,
  source: "USER_EXPLICIT",
  type: "USER_INPUT",
  content: "<USER_REQUEST>\nGo on\n</USER_REQUEST>",
})

const claude = [
  {
    type: "user",
    timestamp: "2026-10-11T17:09:14.000Z",
    message: { role: "user", content: "Check the folder" },
  },
  {
    type: "assistant",
    timestamp: "2026-10-11T17:09:15.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Let me check the folder." }] },
  },
  {
    type: "user",
    timestamp: "2026-10-11T17:09:16.000Z",
    message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
  },
  {
    type: "user",
    timestamp: "2026-10-11T17:09:17.000Z",
    message: { role: "user", content: "Go on" },
  },
].map((record) => JSON.stringify(record))

describe("an interruption the runner tells", () => {
  it("reads in Antigravity's chat as Claude Code's own record of one does, after the turn's last step", () => {
    const items = (line: string) => transcriptsOf.agy.items(line)
    const joined = [
      ...agy.flatMap(items),
      interruptionEntry(Date.parse("2026-10-11T17:09:16Z")),
      ...items(next),
    ]
    const shown = renderChat(chatItemsFrom(joined), "agy").lines
    expect(shown).toEqual(renderChat(chatItemsOf("claude", claude), "claude").lines)
    expect(shown).toContain("note: Interrupted")
  })
})
