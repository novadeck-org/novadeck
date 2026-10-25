import type { ChatRequest } from "./conversation"
import { inboxType, letterItem, ordered, urgency, type InboxContent, type InboxItem } from "./inbox"
import { describe, expect, it } from "./test"

const source: InboxItem["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "t1",
  agent: "claude",
  title: "Title",
  projectName: "Project",
}

const request = (kind: ChatRequest["kind"]): InboxContent => ({
  kind: "request",
  request: {
    id: "r",
    kind,
    tool: "Bash",
    subject: null,
    choices: [],
    subagent: false,
    dialog: null,
    answered: false,
  },
})
const held: InboxContent = {
  kind: "held",
  held: {
    threadId: "h",
    from: { handle: "t1", title: "a" },
    to: { handle: "t2", title: "b" },
    text: "hi",
    hop: 3,
    heldFor: "loop",
  },
}
const ask: InboxContent = {
  kind: "ask",
  ask: { subject: "s", body: "b", details: null, hardToUndo: null, shape: { type: "text" } },
}
const limit: InboxContent = {
  kind: "trouble",
  trouble: { type: "limit", minutes: 300, resetsAt: 0, autoResume: false, evidence: [] },
}
const failed: InboxContent = { kind: "trouble", trouble: { type: "failed", error: null } }
const told: InboxContent = { kind: "update", update: { type: "told", subject: "s", body: "b" } }

const item = (id: string, content: InboxContent, stopped: boolean, at = 0): InboxItem => ({
  ...content,
  id,
  source,
  at,
  stopped,
  seen: false,
})

describe("inboxType", () => {
  it("presents a permission or a plan as an approve and a question as an ask", () => {
    expect(inboxType(request("permission"))).toBe("approve")
    expect(inboxType(request("plan"))).toBe("approve")
    expect(inboxType(request("question"))).toBe("ask")
  })

  it("presents a held message as an approve, and the rest by their source", () => {
    expect(inboxType(held)).toBe("approve")
    expect(inboxType(ask)).toBe("ask")
    expect(inboxType(failed)).toBe("trouble")
    expect(inboxType(told)).toBe("update")
  })
})

describe("urgency", () => {
  it("ranks stopping trouble, other stops, asks that go on, handled trouble, then updates", () => {
    expect(urgency(item("a", failed, true))).toBe(0)
    expect(urgency(item("b", held, true))).toBe(1)
    expect(urgency(item("c", ask, true))).toBe(1)
    expect(urgency(item("d", ask, false))).toBe(2)
    expect(urgency(item("e", failed, false))).toBe(3)
    expect(urgency(item("g", limit, true))).toBe(1)
    expect(urgency(item("h", limit, false))).toBe(3)
    expect(urgency(item("f", told, false))).toBe(4)
  })

  it("keeps an update last even when the agent is stopped", () => {
    expect(urgency(item("f", told, true))).toBe(4)
  })
})

describe("ordered", () => {
  it("sorts by urgency, then the longest waiting first", () => {
    const items = [
      item("update", told, false, 1),
      item("late", held, true, 20),
      item("trouble", failed, true, 30),
      item("early", ask, true, 10),
    ]
    expect(ordered(items).map((each) => each.id)).toEqual(["trouble", "early", "late", "update"])
  })

  it("leaves its input as it was", () => {
    const items = [item("b", told, false, 2), item("a", failed, true, 1)]
    ordered(items)
    expect(items.map((each) => each.id)).toEqual(["b", "a"])
  })
})

describe("letterItem", () => {
  const letter = "8f1c2a3b-0d4e-4f5a-9b6c-7d8e9f0a1b2c"

  it("finds the item a letter came from, as the runner names the letter", () => {
    const items = [item("other", told, false), item(letter, ask, true)]
    expect(letterItem(items, { id: `m-${letter.replaceAll("-", "")}` })?.id).toBe(letter)
    expect(letterItem(items, { id: letter })?.id).toBe(letter)
  })

  it("finds nothing for a letter with no item, not another item of its terminal", () => {
    expect(letterItem([item("other", held, true)], { id: "m-gone" })).toBeUndefined()
  })
})
