import type { ChatItem } from "@novadeck/core/conversation"

import type { SentBubble } from "./bubbles"
import { promptsOf, recall, walksAt, type SentShell, type Walk } from "./history"
import { describe, expect, it } from "./test"

const item = (text: string, extra: Partial<ChatItem> = {}): ChatItem =>
  ({
    id: text,
    at: null,
    role: "user",
    kind: "text",
    text,
    truncated: false,
    interrupted: false,
    ring: null,
    ...extra,
  }) as ChatItem

const sent = (text: string, at: number | null = null): SentBubble => ({
  ref: text,
  text,
  state: "sending",
  at,
})

const never = () => false

const given = (
  items: ChatItem[],
  {
    bubbles = [],
    shells = [],
    agent = "claude",
    opens = never,
  }: {
    bubbles?: SentBubble[]
    shells?: SentShell[]
    agent?: string | null
    opens?: (text: string) => boolean
  } = {},
) => promptsOf(items, bubbles, shells, agent, opens)

describe("the prompts the person gave an agent", () => {
  it("are the recorded ones oldest first, then those sent and not recorded yet", () => {
    expect(
      given([item("one"), item("reply", { role: "assistant" }), item("two")], {
        bubbles: [sent("three")],
      }),
    ).toEqual(["one", "two", "three"])
  })

  it("leave out what the person didn't write", () => {
    expect(
      given([
        item("Interrupted", { interrupted: true }),
        item("doorbell", { ring: { nonce: "n", replies: false } }),
        item("from a peer", { role: "agent", author: "/root/a" }),
        item("tool", { role: "tool", kind: "tool-result" }),
        item("cut", { truncated: true }),
        item("mine"),
      ]),
    ).toEqual(["mine"])
  })

  it("keep a shell command as the person typed it", () => {
    expect(given([item("!ls -la")])).toEqual(["!ls -la"])
  })

  it("collapse a prompt that repeats the one before, and keep one that comes back later", () => {
    expect(given([item("a"), item("a"), item("b"), item("a")], { bubbles: [sent("a")] })).toEqual([
      "a",
      "b",
      "a",
    ])
  })

  it("drop the place an image had, leaving one space, and a prompt that was only that", () => {
    expect(
      given([item("[Image #1] what is this?"), item("see [Image #2] and [Image #3] here")]),
    ).toEqual(["what is this?", "see and here"])
    expect(given([item("[Image #2]")])).toEqual([])
  })

  it("leave out words that would call up the harness's menu in the box", () => {
    expect(
      given([item("/clear"), item("look at @src"), item("fine")], {
        opens: (text) => /^\/|@\w*$/.test(text),
      }),
    ).toEqual(["fine"])
  })

  it("leave out Codex's answers to its questions in both shapes, though not another harness's", () => {
    const during = item("Re: Which one?\nThe first")
    const after = item("> Which one?\n\nThe first")
    expect(given([during, after, item("mine")], { agent: "codex" })).toEqual(["mine"])
    expect(given([during, after], { agent: "claude" })).toEqual([
      "Re: Which one?\nThe first",
      "> Which one?\n\nThe first",
    ])
  })
})

describe("the order of the prompts", () => {
  it("puts a prompt sent and not recorded where its time falls, not always last", () => {
    const recorded = [item("one", { at: 1000 }), item("three", { at: 5000 })]
    expect(given(recorded, { bubbles: [sent("two", 3000), sent("four", 9000)] })).toEqual([
      "one",
      "two",
      "three",
      "four",
    ])
  })

  it("puts a prompt with no time last", () => {
    expect(given([item("one", { at: 1000 })], { bubbles: [sent("two")] })).toEqual(["one", "two"])
  })
})

describe("the shell commands sent from the chat", () => {
  it("are there where the record has none, as on Antigravity", () => {
    expect(
      given([item("before", { at: 1000 }), item("after", { at: 9000 })], {
        agent: "agy",
        shells: [{ text: "!ls", at: 5000 }],
      }),
    ).toEqual(["before", "!ls", "after"])
  })

  it("are there once when the record has them too, however the command was spaced", () => {
    expect(
      given([item("!ls -la", { at: 5100 })], { shells: [{ text: "! ls -la", at: 5000 }] }),
    ).toEqual(["!ls -la"])
    expect(
      given([item("!ls -la", { at: null })], { shells: [{ text: "!ls -la", at: 5000 }] }),
    ).toEqual(["!ls -la"])
  })

  it("are kept when the record has only an earlier run of the same command", () => {
    expect(
      given([item("!ls", { at: 1000 }), item("other", { at: 2000 })], {
        shells: [{ text: "!ls", at: 60_000 }],
      }),
    ).toEqual(["!ls", "other", "!ls"])
  })
})

describe("the keys that walk the history", () => {
  const walk: Walk = { at: 0, shown: "a long\nprompt", typed: "" }

  it("start with Up from the very start of the box, and leave the caret anywhere else", () => {
    expect(walksAt(null, "ArrowUp", "", 0, 0)).toBe(true)
    expect(walksAt(null, "ArrowUp", "a long soft-wrapped draft", 0, 0)).toBe(true)
    expect(walksAt(null, "ArrowUp", "a long soft-wrapped draft", 10, 10)).toBe(false)
    expect(walksAt(null, "ArrowUp", "a long soft-wrapped draft", 0, 6)).toBe(false)
  })

  it("never start with Down", () => {
    expect(walksAt(null, "ArrowDown", "", 0, 0)).toBe(false)
    expect(walksAt(null, "ArrowDown", "draft", 5, 5)).toBe(false)
  })

  it("go on with either key, wherever the caret is, while the box shows the walk's prompt", () => {
    expect(walksAt(walk, "ArrowUp", walk.shown, 4, 4)).toBe(true)
    expect(walksAt(walk, "ArrowDown", walk.shown, 2, 2)).toBe(true)
  })

  it("end with an edit", () => {
    expect(walksAt(walk, "ArrowDown", "a long\nprompt!", 3, 3)).toBe(false)
    expect(walksAt(walk, "ArrowUp", "a long\nprompt!", 3, 3)).toBe(false)
  })
})

describe("recalling a prompt", () => {
  const prompts = ["a", "b", "c"]
  const up = (walk: Walk | null, draft: string) => recall(prompts, walk, draft, "ArrowUp")
  const down = (walk: Walk | null, draft: string) => recall(prompts, walk, draft, "ArrowDown")

  it("goes back from the newest with each Up, and stops at the oldest", () => {
    const first = up(null, "typing")!
    expect(first.draft).toBe("c")
    const second = up(first.walk, first.draft)!
    expect(second.draft).toBe("b")
    const third = up(second.walk, second.draft)!
    expect(third.draft).toBe("a")
    expect(up(third.walk, third.draft)).toBeNull()
  })

  it("comes forward with Down and ends on exactly what was being typed", () => {
    const first = up(null, "half  a\nthought ")!
    const second = up(first.walk, first.draft)!
    const back = down(second.walk, second.draft)!
    expect(back.draft).toBe("c")
    const end = down(back.walk, back.draft)!
    expect(end).toEqual({ walk: null, draft: "half  a\nthought " })
  })

  it("has no Down to make when nothing was recalled", () => {
    expect(down(null, "typing")).toBeNull()
  })

  it("starts again from the newest once the box shows other words", () => {
    const first = up(null, "")!
    const second = up(first.walk, first.draft)!
    expect(up(second.walk, "edited")).toEqual({
      walk: { at: 0, shown: "c", typed: "edited" },
      draft: "c",
    })
  })

  it("has nothing to recall with no history", () => {
    expect(recall([], null, "x", "ArrowUp")).toBeNull()
  })
})
