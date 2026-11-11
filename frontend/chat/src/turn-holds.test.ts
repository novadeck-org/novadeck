import type { ChatItem } from "@novadeck/core/conversation"
import { groupItems, type ChatBlock } from "@novadeck/core/conversation/turns"

import { describe, expect, it } from "./test"
import {
  currentPrompt,
  heldAt,
  neighbours,
  oneLine,
  peekHeight,
  scrollFor,
  startRows,
  sentence,
  turnStarts,
  type StartRow,
} from "./turn-holds"

const item = (over: Partial<ChatItem>): ChatItem => ({
  id: "i",
  at: null,
  role: "user",
  kind: "text",
  text: "",
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  outcome: null,
  scripted: false,
  interrupted: false,
  ring: null,
  ...over,
})

const prompt = (id: string): ChatBlock => ({
  kind: "user",
  id,
  text: id,
  truncated: false,
  at: null,
})
const reply = (id: string): ChatBlock => ({
  kind: "assistant",
  id,
  text: id,
  truncated: false,
  at: null,
})
const ring = (id: string): ChatBlock => ({
  kind: "doorbell",
  id,
  at: null,
  messages: null,
  replies: false,
})

describe("where a turn starts", () => {
  it("is at the person's prompt, and at a ring that started one, which is not theirs", () => {
    const blocks = [prompt("p1"), reply("a1"), ring("r1"), reply("a2"), prompt("p2")]
    expect(turnStarts(blocks)).toEqual([
      { id: "p1", mine: true },
      { id: "r1", mine: false },
      { id: "p2", mine: true },
    ])
  })

  it("is never at another agent's message, a note or the agent's own words", () => {
    const blocks: ChatBlock[] = [
      prompt("p1"),
      { kind: "agent", id: "m", author: "@crow", text: "hi", truncated: false, at: null },
      { kind: "note", id: "n", text: "Interrupted" },
      reply("a1"),
    ]
    expect(turnStarts(blocks)).toEqual([{ id: "p1", mine: true }])
  })

  it("is not at a message the doorbell delivered into a turn that was running", () => {
    // The record has the prompt and the agent's words; the delivered message and the person's
    // Inbox answer are in no item of it, so no block starts a turn for them.
    const blocks = groupItems(
      [
        item({ id: "1", at: 1_000, text: "Fix it" }),
        item({ id: "2", at: 2_000, role: "assistant", text: "On it." }),
      ],
      [
        {
          id: "m1",
          hop: 1,
          from: { kind: "agent", handle: "crow", agent: "codex" },
          to: { kind: "person" },
          text: "FYI",
          sentAt: 1_200,
          state: "delivered",
          held: null,
          deliveredAt: 1_500,
        },
        {
          id: "m2",
          inbox: "answer",
          hop: 1,
          from: { kind: "person" },
          to: { kind: "agent", handle: "moth", agent: "claude" },
          text: "Yes, go ahead",
          sentAt: 1_600,
          state: "delivered",
          held: null,
          deliveredAt: 1_700,
        },
      ],
    )
    expect(turnStarts(blocks).map(({ mine }) => mine)).toEqual([true])
  })

  it("is at a ring the record holds, which carries its messages with it", () => {
    const blocks = groupItems([
      item({ id: "1", at: 1_000, text: "Fix it" }),
      item({ id: "2", at: 2_000, role: "assistant", text: "Done." }),
      item({ id: "3", at: 3_000, text: "[line]", ring: { nonce: "n", replies: false } }),
    ])
    expect(turnStarts(blocks)).toEqual([
      { id: "1", mine: true },
      { id: "3", mine: false },
    ])
  })

  it("has no start for a prompt still on its way, which is no block", () => {
    // Queued bubbles are drawn beside the blocks (`withBubbles`), never among them.
    expect(turnStarts([prompt("p1"), reply("a1")])).toEqual([{ id: "p1", mine: true }])
  })
})

describe("the prompt of the current turn", () => {
  it("is the latest turn's, where that is the person's", () => {
    expect(currentPrompt([prompt("p1"), reply("a"), prompt("p2"), reply("b")])).toBe("p2")
  })

  it("is none where a ring started the latest turn", () => {
    expect(currentPrompt([prompt("p1"), reply("a"), ring("r1"), reply("b")])).toBeNull()
  })

  it("is none for a conversation with no turn", () => {
    expect(currentPrompt([])).toBeNull()
  })
})

// Three turns of the person's, 100 high each: a prompt 20 tall at the top of each.
const row = (id: string, top: number, mine = true): StartRow => ({
  id,
  mine,
  top,
  bottom: top + 20,
})
const rows = [row("a", 0), row("b", 100), row("c", 200)]
const height = 37

describe("which prompt holds the top", () => {
  it("is none while the first prompt is in view", () => {
    expect(heldAt(rows, 0, height)).toBeNull()
    expect(heldAt(rows, 10, height)).toBeNull()
  })

  it("is the turn's prompt once its row is wholly above the top", () => {
    expect(heldAt(rows, 20, height)).toEqual({ id: "a", offset: 0 })
    expect(heldAt(rows, 60, height)).toEqual({ id: "a", offset: 0 })
  })

  it("is the earlier turn's where the person has scrolled back into it", () => {
    expect(heldAt(rows, 150, height)).toEqual({ id: "b", offset: 0 })
    expect(heldAt(rows, 40, height)).toEqual({ id: "a", offset: 0 })
  })

  it("is pushed up by the next turn's start as it arrives under the held line", () => {
    // The next prompt is 37 below the top: just touching the held line, no push yet.
    expect(heldAt(rows, 63, height)).toEqual({ id: "a", offset: 0 })
    expect(heldAt(rows, 73, height)).toEqual({ id: "a", offset: -10 })
    expect(heldAt(rows, 99, height)).toEqual({ id: "a", offset: -36 })
  })

  it("is gone once the next prompt is at the top, and back once its own row has passed", () => {
    expect(heldAt(rows, 100, height)).toBeNull()
    expect(heldAt(rows, 110, height)).toBeNull()
    expect(heldAt(rows, 120, height)).toEqual({ id: "b", offset: 0 })
  })

  it("is the last turn's with nothing to push it", () => {
    expect(heldAt(rows, 500, height)).toEqual({ id: "c", offset: 0 })
  })

  it("is nothing inside a turn a ring started, whose own start pushes the line before", () => {
    const withRing = [row("a", 0), row("r", 100, false), row("c", 200)]
    expect(heldAt(withRing, 60, height)).toEqual({ id: "a", offset: 0 })
    // The ring's row arrives: the earlier prompt is pushed out and the ring holds nothing.
    expect(heldAt(withRing, 80, height)).toEqual({ id: "a", offset: -17 })
    expect(heldAt(withRing, 100, height)).toBeNull()
    expect(heldAt(withRing, 150, height)).toBeNull()
    expect(heldAt(withRing, 220, height)).toEqual({ id: "c", offset: 0 })
  })

  it("is none for a log with no turn", () => {
    expect(heldAt([], 300, height)).toBeNull()
  })
})

describe("the steps between prompts", () => {
  const starts = [
    { id: "a", mine: true },
    { id: "r", mine: false },
    { id: "b", mine: true },
    { id: "c", mine: true },
  ]

  it("go to the person's prompts either side, skipping a ring's turn", () => {
    expect(neighbours(starts, "b")).toEqual({ before: "a", after: "c" })
  })

  it("have none before the first and none after the latest", () => {
    expect(neighbours(starts, "a")).toEqual({ before: null, after: "b" })
    expect(neighbours(starts, "c")).toEqual({ before: "b", after: null })
  })
})

describe("scrolling to a prompt", () => {
  it("goes to its row, where a first row sits, or just past it so the prompt holds the top", () => {
    expect(scrollFor(row("b", 100), "row", 22)).toBe(78)
    expect(scrollFor(row("b", 100), "past")).toBe(120)
    expect(scrollFor(row("a", -5), "row", 22)).toBe(0)
  })

  it("keeps whole pixels, so a row's fraction never leaves its last pixel showing", () => {
    const fractional = { ...row("b", 70.4), bottom: 90.40625 }
    expect(scrollFor(fractional, "past")).toBe(91)
    expect(heldAt([row("a", 0), fractional], scrollFor(fractional, "past"), height)?.id).toBe("b")
    // Even a position the browser rounded down to leaves the prompt held.
    expect(heldAt([row("a", 0), fractional], 90, height)?.id).toBe("b")
  })
})

describe("where the rows stand on a scaled page", () => {
  it("is in the log's own pixels at a Canvas zoom, as its scroll position is", () => {
    const scroller = document.createElement("div")
    const node = document.createElement("div")
    node.dataset.turn = "a"
    scroller.append(node)
    // Zoomed to 0.5: the log is 400 wide in its own pixels, 200 on the page; scrolled 100 of its
    // own; the row stands 300 down its content and 20 tall.
    Object.defineProperty(scroller, "offsetWidth", { value: 400 })
    Object.defineProperty(scroller, "scrollTop", { value: 100 })
    scroller.getBoundingClientRect = () => ({ top: 50, width: 200 }) as DOMRect
    node.getBoundingClientRect = () =>
      ({ top: 50 + (300 - 100) * 0.5, bottom: 50 + (320 - 100) * 0.5 }) as DOMRect
    expect(startRows(scroller, [{ id: "a", mine: true }])).toEqual([
      { id: "a", mine: true, top: 300, bottom: 320 },
    ])
  })
})

describe("how tall the peek's words stand", () => {
  it("is two fifths of the chat where the log area has room", () => {
    expect(peekHeight({ chat: 600, main: 500, chrome: 60, line: 21 })).toBe(240)
  })

  it("is what the log area leaves, so the footer stays in view, but one line at least", () => {
    expect(peekHeight({ chat: 600, main: 200, chrome: 60, line: 21 })).toBe(140)
    expect(peekHeight({ chat: 600, main: 63, chrome: 60, line: 18 })).toBe(18)
  })
})

describe("a prompt as one line", () => {
  it("turns its breaks into spaces and keeps its image placeholders", () => {
    expect(oneLine("[Image #1] is the mock.\n\n  Plan it\r\nfrom this.")).toBe(
      "[Image #1] is the mock. Plan it from this.",
    )
  })
})

describe("a prompt as a sentence in a label", () => {
  it("adds a full stop only where the words don't end one", () => {
    expect(sentence("Keep the old path working")).toBe("Keep the old path working.")
    expect(sentence("so the other branches don't break.")).toBe(
      "so the other branches don't break.",
    )
    expect(sentence("Which build tool does this project use?")).toBe(
      "Which build tool does this project use?",
    )
  })
})
