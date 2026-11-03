import { sentBubbles } from "@novadeck/chat/bubbles"
import type { ChatSend } from "@novadeck/chat/sends"
import type { ChatPrompt } from "@novadeck/core/conversation"
import type { AgentName } from "@novadeck/protocol/harnesses"

import { chatItemsOf, renderChat } from "./pipeline"
import { describe, expect, it } from "./test"

// The person's prompts the agent's record doesn't show yet, as the chat draws them among a
// conversation each harness recorded in its own shape: one on its way, one queued behind
// it, one the record never got, one back in the agent's box, and one settled whose item
// is yet to arrive. Each sits where it was sent, before the first block recorded after it.

const time = (second: number) => `2026-11-03T17:00:${String(second).padStart(2, "0")}.000Z`
const at = (second: number) => Date.parse(time(second))

// The person asks, the agent answers, and the person asks again: the record's own items.
const recorded: Readonly<Record<AgentName, readonly string[]>> = {
  claude: [
    { type: "user", timestamp: time(1), message: { role: "user", content: "Check the folder" } },
    {
      type: "assistant",
      timestamp: time(5),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The folder holds two files." }],
      },
    },
    { type: "user", timestamp: time(9), message: { role: "user", content: "Open the first" } },
  ].map((record) => JSON.stringify(record)),
  codex: [
    ["user", "input_text", "Check the folder", 1],
    ["assistant", "output_text", "The folder holds two files.", 5],
    ["user", "input_text", "Open the first", 9],
  ].map(([role, type, text, second]) =>
    JSON.stringify({
      type: "response_item",
      timestamp: time(second as number),
      payload: { type: "message", role, content: [{ type, text }] },
    }),
  ),
  agy: [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "<USER_REQUEST>\nCheck the folder\n</USER_REQUEST>",
      created_at: time(1),
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "The folder holds two files.",
      created_at: time(5),
    },
    {
      step_index: 2,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: "<USER_REQUEST>\nOpen the first\n</USER_REQUEST>",
      created_at: time(9),
    },
  ].map((step) => JSON.stringify(step)),
}

const receipt = (
  ref: string,
  text: string,
  second: number,
  state: ChatPrompt["state"],
  item: number | null = null,
): ChatPrompt => ({ ref, text, sentAt: at(second), state, item })

// Receipts a runner told any window, and this window's own sends.
const prompts: readonly ChatPrompt[] = [
  receipt("lost000000000000", "Also list hidden ones", 3, "unrecorded"),
  receipt("boxed00000000000", "And their sizes", 7, "in-box"),
  receipt("settled000000000", "Open the second too", 11, "settled", 3),
  receipt("going00000000000", "Then sum it up", 12, "pending"),
]
const sends: readonly ChatSend[] = [
  { ref: "queued0000000000", draft: "thanks", text: "thanks", to: null, phase: "queued" },
]

describe("the person's prompts not in the agent's record yet", () => {
  for (const harness of ["claude", "codex", "agy"] as const)
    it(`show among ${harness}'s recorded conversation as its golden`, async () => {
      const items = chatItemsOf(harness, recorded[harness])
      const { lines } = renderChat(items, harness, sentBubbles(sends, prompts, items.length))
      await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot(`./sent/${harness}.txt`)
    })

  it("draws them alike on every harness, but for the agent's name", () => {
    const shown = (["claude", "codex", "agy"] as const).map((harness) => {
      const items = chatItemsOf(harness, recorded[harness])
      return renderChat(items, harness, sentBubbles(sends, prompts, items.length)).lines.map(
        (line) => line.replace(/back in \w+(?: Code)?'s box/, "back in the agent's box"),
      )
    })
    expect(shown[1]).toEqual(shown[0])
    expect(shown[2]).toEqual(shown[0])
  })

  it("lets a settled prompt go once its item arrives", () => {
    const items = chatItemsOf("claude", recorded.claude)
    const settled = [receipt("settled000000000", "Open the first", 8, "settled", 2)]
    expect(renderChat(items, "claude", sentBubbles([], settled, items.length)).lines).not.toContain(
      expect.stringMatching(/^sent/),
    )
  })
})
