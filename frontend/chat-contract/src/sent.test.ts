import { readdirSync } from "node:fs"
import { join } from "node:path"

import { sentBubbles } from "@novadeck/chat/bubbles"
import type { ChatSend } from "@novadeck/chat/sends"
import type { ChatPrompt } from "@novadeck/core/conversation"
import { agentNames, type AgentName } from "@novadeck/protocol/harnesses"

import { recordedScenarios } from "./fixtures"
import { chatItemsOf, renderChat } from "./pipeline"
import { describe, expect, it } from "./test"

// The person's prompts the agent's record doesn't show yet, as the chat draws them among a
// conversation each harness recorded in its own shape: one on its way, one queued behind
// it, one the record never got, one back in the agent's box, and one settled whose item
// is yet to arrive. Each sits where it was sent, before the first block recorded after it.

const time = (second: number) => `2026-11-03T17:00:${String(second).padStart(2, "0")}.000Z`
const at = (second: number) => Date.parse(time(second))

// opencode's: two recorded prompts and the answer to the first (src/recorded/opencode-words.json,
// said to the fake model as the others' words), their times set where the others' are.
const opencodeRecorded = (): readonly string[] => {
  const words = recordedScenarios("opencode-words.json")
  const lines = [...words["check-the-folder"]!, ...words["open-the-first"]!.slice(0, 1)]
  const stamps = [1, 5, 9].map(at)
  let prompt = 0
  return lines.map((line) => {
    const record = structuredClone(line) as {
      type: string
      info?: { time?: { created?: number } }
      part?: { type?: string; time?: { start: number; end: number } }
    }
    if (record.type === "prompt" && record.info?.time)
      record.info.time.created = stamps[prompt++ * 2]!
    if (record.part?.type === "text" && record.part.time)
      record.part.time = { start: stamps[1]!, end: stamps[1]! }
    return JSON.stringify(record)
  })
}

// pi's: the same two recorded prompts and the answer to the first (src/recorded/pi-words.json),
// their times set where the others' are: pi keeps a message's own time beside its record's.
const piRecorded = (): readonly string[] => {
  const words = recordedScenarios("pi-words.json")
  type Record = {
    type: string
    timestamp?: string
    message?: { role?: string; timestamp?: number }
  }
  const said = (records: readonly object[]) =>
    records.filter((record) => {
      const role = (record as Record).message?.role
      return role === "user" || role === "assistant"
    })
  const lines = [...said(words["check-the-folder"]!), ...said(words["open-the-first"]!).slice(0, 1)]
  return lines.map((line, place) => {
    const record = structuredClone(line) as Record
    const second = [1, 5, 9][place]!
    record.timestamp = time(second)
    if (record.message) record.message.timestamp = Date.parse(time(second))
    return JSON.stringify(record)
  })
}

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
  opencode: opencodeRecorded(),
  pi: piRecorded(),
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
  receipt("settled000000000", "Open the second too", 11, "settled", 99),
  receipt("going00000000000", "Then sum it up", 12, "pending"),
]
const sends: readonly ChatSend[] = [
  {
    ref: "queued0000000000",
    draft: "thanks",
    text: "thanks",
    images: [],
    at: [],
    to: null,
    phase: "queued",
  },
]

describe("the person's prompts not in the agent's record yet", () => {
  for (const harness of agentNames)
    it(`show among ${harness}'s recorded conversation as its golden`, async () => {
      const items = chatItemsOf(harness, recorded[harness])
      const { lines } = renderChat(items, harness, sentBubbles(sends, prompts, items))
      await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot(`./sent/${harness}.txt`)
    })

  it("draws them alike on every harness, but for the agent's name", () => {
    const shown = agentNames.map((harness) => {
      const items = chatItemsOf(harness, recorded[harness])
      return renderChat(items, harness, sentBubbles(sends, prompts, items)).lines.map((line) =>
        line.replace(/back in \w+(?: Code)?'s box/, "back in the agent's box"),
      )
    })
    for (const other of shown.slice(1)) expect(other).toEqual(shown[0])
  })

  it("lets a settled prompt go once its item arrives", () => {
    const items = chatItemsOf("claude", recorded.claude)
    const settled = [receipt("settled000000000", "Open the first", 8, "settled", 2)]
    const { lines } = renderChat(items, "claude", sentBubbles([], settled, items))
    // `toContain` compares by `===`, which a matcher never is, so it could never fail here.
    expect(lines).not.toContainEqual(expect.stringMatching(/^sent/))
    expect(lines).toContain("user: Open the first")
  })

  it("keeps a golden for each harness, and no other", () => {
    const kept = readdirSync(join(import.meta.dirname, "sent")).toSorted()
    expect(kept).toEqual(agentNames.map((harness) => `${harness}.txt`).toSorted())
  })
})
