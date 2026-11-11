import { turnStarts } from "@novadeck/chat/turn-holds"
import { groupItems } from "@novadeck/core/conversation/turns"
import { agentNames, type AgentName } from "@novadeck/protocol/harnesses"

import { chatItemsOf } from "./pipeline"
import { describe, expect, it } from "./test"

// Which records start a turn for the chat's held prompt, in each harness's own shape: the
// person's prompt does, and so does a prompt the agent took in while its turn ran (Claude Code's
// `queued_command`, Codex's and Antigravity's steering, recorded as a user message among the
// turn's own), as `turnsWorked` also reads it. The held line moves to the latest prompt the agent
// has taken.

const time = (second: number) => `2026-11-03T17:00:${String(second).padStart(2, "0")}.000Z`

const records: Readonly<Record<AgentName, readonly object[]>> = {
  claude: [
    { type: "user", timestamp: time(1), message: { role: "user", content: "Run the tests" } },
    {
      type: "assistant",
      timestamp: time(3),
      message: { role: "assistant", content: [{ type: "text", text: "Running them." }] },
    },
    {
      type: "attachment",
      timestamp: time(5),
      attachment: {
        type: "queued_command",
        origin: { kind: "human" },
        commandMode: "prompt",
        prompt: "Skip the slow ones",
      },
    },
    {
      type: "assistant",
      timestamp: time(7),
      message: { role: "assistant", content: [{ type: "text", text: "Skipping them." }] },
    },
  ],
  codex: [
    ["user", "input_text", "Run the tests", 1],
    ["assistant", "output_text", "Running them.", 3],
    // Steering: the person's words, recorded among the turn's own.
    ["user", "input_text", "Skip the slow ones", 5],
    ["assistant", "output_text", "Skipping them.", 7],
  ].map(([role, type, text, second]) => ({
    type: "response_item",
    timestamp: time(second as number),
    payload: { type: "message", role, content: [{ type, text }] },
  })),
  agy: [
    ["USER_INPUT", "USER_EXPLICIT", "<USER_REQUEST>\nRun the tests\n</USER_REQUEST>", 1],
    ["PLANNER_RESPONSE", "MODEL", "Running them.", 3],
    ["USER_INPUT", "USER_EXPLICIT", "<USER_REQUEST>\nSkip the slow ones\n</USER_REQUEST>", 5],
    ["PLANNER_RESPONSE", "MODEL", "Skipping them.", 7],
  ].map(([type, source, content, second], index) => ({
    step_index: index,
    source,
    type,
    content,
    created_at: time(second as number),
  })),
}

describe("which records start a turn", () => {
  for (const harness of agentNames)
    it(`are the person's prompts in ${harness}, including one taken in mid-turn`, () => {
      const items = chatItemsOf(
        harness,
        records[harness].map((record) => JSON.stringify(record)),
      )
      const blocks = groupItems(items)
      expect(turnStarts(blocks).map(({ mine }) => mine)).toEqual([true, true])
      const prompts = blocks.filter(({ kind }) => kind === "user")
      expect(prompts.map((block) => ("text" in block ? block.text : ""))).toEqual([
        "Run the tests",
        "Skip the slow ones",
      ])
    })
})
