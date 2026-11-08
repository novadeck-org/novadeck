import type { ChatItem } from "@novadeck/core/conversation"

import type { SentBubble } from "./bubbles"
import { promptsOf, recall, walksAt, type Walk } from "./history"
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

const sent = (text: string): SentBubble => ({ ref: text, text, state: "sending", at: null })

const never = () => false

describe("the prompts the person gave an agent", () => {
  it("are the recorded ones oldest first, then those sent and not recorded yet", () => {
    const prompts = promptsOf(
      [item("one"), item("reply", { role: "assistant" }), item("two")],
      [sent("three")],
      "claude",
      never,
    )
    expect(prompts).toEqual(["one", "two", "three"])
  })

  it("leave out what the person didn't write", () => {
    const prompts = promptsOf(
      [
        item("Interrupted", { interrupted: true }),
        item("doorbell", { ring: { nonce: "n", replies: false } }),
        item("from a peer", { role: "agent", author: "/root/a" }),
        item("tool", { role: "tool", kind: "tool-result" }),
        item("cut", { truncated: true }),
        item("mine"),
      ],
      [],
      "claude",
      never,
    )
    expect(prompts).toEqual(["mine"])
  })

  it("keep a shell command as the person typed it", () => {
    expect(promptsOf([item("!ls -la")], [], "claude", never)).toEqual(["!ls -la"])
  })

  it("collapse a prompt that repeats the one before, and keep one that comes back later", () => {
    const prompts = promptsOf(
      [item("a"), item("a"), item("b"), item("a")],
      [sent("a")],
      null,
      never,
    )
    expect(prompts).toEqual(["a", "b", "a"])
  })

  it("drop the place an image had, and a prompt that was only that", () => {
    const prompts = promptsOf(
      [item("[Image #1] what is this?"), item("[Image #2]")],
      [],
      null,
      never,
    )
    expect(prompts).toEqual(["what is this?"])
  })

  it("leave out words that would call up the harness's menu in the box", () => {
    const prompts = promptsOf(
      [item("/clear"), item("look at @src"), item("fine")],
      [],
      null,
      (text) => /^\/|@\w*$/.test(text),
    )
    expect(prompts).toEqual(["fine"])
  })

  it("leave out Codex's answers to its async questions, though not another harness's", () => {
    const answer = item("Re: Which one?\nThe first")
    expect(promptsOf([answer], [], "codex", never)).toEqual([])
    expect(promptsOf([answer], [], "claude", never)).toEqual(["Re: Which one?\nThe first"])
  })
})

describe("the keys that walk the history", () => {
  it("are Up on the first line and Down on the last, with nothing selected", () => {
    expect(walksAt("ArrowUp", "one\ntwo", 2, 2)).toBe(true)
    expect(walksAt("ArrowUp", "one\ntwo", 5, 5)).toBe(false)
    expect(walksAt("ArrowDown", "one\ntwo", 5, 5)).toBe(true)
    expect(walksAt("ArrowDown", "one\ntwo", 1, 1)).toBe(false)
    expect(walksAt("ArrowUp", "one", 0, 3)).toBe(false)
    expect(walksAt("ArrowUp", "", 0, 0)).toBe(true)
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
