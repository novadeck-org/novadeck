import type { ChatRequest } from "./conversation"
import {
  inboxType,
  entryRow,
  nextLimitReset,
  ordered,
  terminalDone,
  terminalNeed,
  urgency,
  type InboxContent,
  type InboxRow,
} from "./inbox"
import { describe, expect, it } from "./test"

const source: InboxRow["source"] = {
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

const draft: InboxContent = { kind: "feedback", draft: { kind: "bug", text: "It broke." } }

const item = (id: string, content: InboxContent, stopped: boolean, at = 0): InboxRow => ({
  ...content,
  id,
  source,
  at,
  stopped,
  seen: false,
})

const action: InboxContent = {
  kind: "ask",
  ask: {
    subject: "Log in",
    body: "b",
    details: null,
    hardToUndo: null,
    shape: { type: "action", command: "vercel login", directory: null, doneLabel: "Done" },
  },
}
const done: InboxContent = { kind: "update", update: { type: "done", subject: "s", body: "b" } }

describe("inboxType", () => {
  it("presents a permission or a plan as an unblock and a question as an ask", () => {
    expect(inboxType(request("permission"))).toBe("unblock")
    expect(inboxType(request("plan"))).toBe("unblock")
    expect(inboxType(request("question"))).toBe("ask")
  })

  it("presents a held message as an unblock, and the rest by their source", () => {
    expect(inboxType(held)).toBe("unblock")
    expect(inboxType(ask)).toBe("ask")
    expect(inboxType(failed)).toBe("trouble")
    expect(inboxType(told)).toBe("update")
    expect(inboxType(done)).toBe("update")
    expect(inboxType(draft)).toBe("feedback")
  })

  it("presents an ask the person answers by doing something as an unblock", () => {
    expect(inboxType(action)).toBe("unblock")
  })
})

describe("what a terminal needs and has done", () => {
  const at = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }
  const elsewhere = { ...source, terminalId: "other" }
  const there = (id: string, content: InboxContent, seen = false): InboxRow => ({
    ...item(id, content, true),
    seen,
  })
  const away = (id: string, content: InboxContent): InboxRow => ({
    ...item(id, content, true),
    source: elsewhere,
  })
  const limitAt = (resetsAt: number, autoResume: boolean | null): InboxContent => ({
    kind: "trouble",
    trouble: { type: "limit", minutes: 300, resetsAt, autoResume, evidence: [] },
  })

  it("needs an unblock for a permission, a held message or an action ask", () => {
    for (const content of [request("permission"), held, action])
      expect(terminalNeed([there("a", content)], at, 0)).toBe("unblock")
  })

  it("needs an answer for a question or an ask, and an unblock wins over it", () => {
    expect(terminalNeed([there("a", request("question"))], at, 0)).toBe("ask")
    expect(terminalNeed([there("a", ask)], at, 0)).toBe("ask")
    expect(terminalNeed([there("a", ask), there("b", held)], at, 0)).toBe("unblock")
  })

  it("needs nothing for trouble, updates or a draft, nor for another terminal's items", () => {
    expect(terminalNeed([there("a", failed), there("b", told), there("c", draft)], at, 0)).toBe(
      undefined,
    )
    expect(terminalNeed([away("a", held)], at, 0)).toBe(undefined)
  })

  it("needs an unblock from a limit only once it has reset and Novadeck won't resume", () => {
    expect(terminalNeed([there("a", limitAt(100, false))], at, 99)).toBe(undefined)
    expect(terminalNeed([there("a", limitAt(100, false))], at, 100)).toBe("unblock")
    expect(terminalNeed([there("a", limitAt(100, null))], at, 100)).toBe("unblock")
    expect(terminalNeed([there("a", limitAt(100, true))], at, 100)).toBe(undefined)
  })

  it("finds the next limit still to reset, for the marks that change then", () => {
    const items = [there("a", limitAt(300, false)), there("b", limitAt(100, false))]
    expect(nextLimitReset(items, 50)).toBe(100)
    expect(nextLimitReset(items, 100)).toBe(300)
    expect(nextLimitReset(items, 300)).toBeUndefined()
    expect(nextLimitReset([there("c", done)], 0)).toBeUndefined()
  })

  it("has a done once its report is unseen, and not for a tell or another terminal", () => {
    expect(terminalDone([there("a", done)], at)).toBe(true)
    expect(terminalDone([there("a", done, true)], at)).toBe(false)
    expect(terminalDone([there("a", told)], at)).toBe(false)
    expect(terminalDone([away("a", done)], at)).toBe(false)
  })
})

describe("urgency", () => {
  it("ranks stopping trouble, other stops, asks that go on, handled trouble, then updates and failed turns that only inform", () => {
    expect(urgency(item("a", failed, true))).toBe(0)
    expect(urgency(item("b", held, true))).toBe(1)
    expect(urgency(item("c", ask, true))).toBe(1)
    expect(urgency(item("d", ask, false))).toBe(2)
    expect(urgency(item("e", failed, false))).toBe(4)
    expect(urgency(item("g", limit, true))).toBe(1)
    expect(urgency(item("h", limit, false))).toBe(3)
    expect(urgency(item("f", told, false))).toBe(4)
  })

  it("ranks a feedback draft with handled trouble, before updates", () => {
    expect(urgency(item("i", draft, false))).toBe(3)
    expect(urgency(item("j", draft, true))).toBe(3)
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

  it("puts settled asks after everything, the latest settled first", () => {
    const settled = (id: string, at: number) => ({
      ...item(id, ask, true, 1),
      settled: { how: "dismissed" as const, at },
    })
    const items = [
      settled("s1", 100),
      item("update", told, false, 1),
      settled("s2", 200),
      item("trouble", failed, true, 30),
    ]
    expect(ordered(items).map((each) => each.id)).toEqual(["trouble", "update", "s2", "s1"])
  })

  it("leaves its input as it was", () => {
    const items = [item("b", told, false, 2), item("a", failed, true, 1)]
    ordered(items)
    expect(items.map((each) => each.id)).toEqual(["b", "a"])
  })
})

describe("entryRow", () => {
  const entry = "8f1c2a3b-0d4e-4f5a-9b6c-7d8e9f0a1b2c"

  it("finds the item an entry came from, as the runner names the entry", () => {
    const items = [item("other", told, false), item(entry, ask, true)]
    expect(entryRow(items, { id: `m-${entry.replaceAll("-", "")}` })?.id).toBe(entry)
    expect(entryRow(items, { id: entry })?.id).toBe(entry)
  })

  it("finds nothing for an entry with no item, not another item of its terminal", () => {
    expect(entryRow([item("other", held, true)], { id: "m-gone" })).toBeUndefined()
  })
})
