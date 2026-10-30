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

const row = (id: string, content: InboxContent, stopped: boolean, at = 0): InboxRow => ({
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
  })

  it("presents an ask the person answers by doing something as an unblock", () => {
    expect(inboxType(action)).toBe("unblock")
  })
})

describe("what a terminal needs and has done", () => {
  const at = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }
  const elsewhere = { ...source, terminalId: "other" }
  const there = (id: string, content: InboxContent, seen = false): InboxRow => ({
    ...row(id, content, true),
    seen,
  })
  const away = (id: string, content: InboxContent): InboxRow => ({
    ...row(id, content, true),
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

  it("needs nothing for trouble or updates, nor for another terminal's rows", () => {
    expect(terminalNeed([there("a", failed), there("b", told)], at, 0)).toBe(undefined)
    expect(terminalNeed([away("a", held)], at, 0)).toBe(undefined)
  })

  it("needs an unblock from a limit only once it has reset and Novadeck won't resume", () => {
    expect(terminalNeed([there("a", limitAt(100, false))], at, 99)).toBe(undefined)
    expect(terminalNeed([there("a", limitAt(100, false))], at, 100)).toBe("unblock")
    expect(terminalNeed([there("a", limitAt(100, null))], at, 100)).toBe("unblock")
    expect(terminalNeed([there("a", limitAt(100, true))], at, 100)).toBe(undefined)
  })

  it("finds the next limit still to reset, for the marks that change then", () => {
    const rows = [there("a", limitAt(300, false)), there("b", limitAt(100, false))]
    expect(nextLimitReset(rows, 50)).toBe(100)
    expect(nextLimitReset(rows, 100)).toBe(300)
    expect(nextLimitReset(rows, 300)).toBeUndefined()
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
    expect(urgency(row("a", failed, true))).toBe(0)
    expect(urgency(row("b", held, true))).toBe(1)
    expect(urgency(row("c", ask, true))).toBe(1)
    expect(urgency(row("d", ask, false))).toBe(2)
    expect(urgency(row("e", failed, false))).toBe(4)
    expect(urgency(row("g", limit, true))).toBe(1)
    expect(urgency(row("h", limit, false))).toBe(3)
    expect(urgency(row("f", told, false))).toBe(4)
  })

  it("keeps an update last even when the agent is stopped", () => {
    expect(urgency(row("f", told, true))).toBe(4)
  })
})

describe("ordered", () => {
  it("sorts by urgency, then the longest waiting first", () => {
    const rows = [
      row("update", told, false, 1),
      row("late", held, true, 20),
      row("trouble", failed, true, 30),
      row("early", ask, true, 10),
    ]
    expect(ordered(rows).map((each) => each.id)).toEqual(["trouble", "early", "late", "update"])
  })

  it("puts settled asks after everything, the latest settled first", () => {
    const settled = (id: string, at: number) => ({
      ...row(id, ask, true, 1),
      settled: { how: "dismissed" as const, at },
    })
    const rows = [
      settled("s1", 100),
      row("update", told, false, 1),
      settled("s2", 200),
      row("trouble", failed, true, 30),
    ]
    expect(ordered(rows).map((each) => each.id)).toEqual(["trouble", "update", "s2", "s1"])
  })

  it("leaves its input as it was", () => {
    const rows = [row("b", told, false, 2), row("a", failed, true, 1)]
    ordered(rows)
    expect(rows.map((each) => each.id)).toEqual(["b", "a"])
  })
})

describe("entryRow", () => {
  const entry = "8f1c2a3b-0d4e-4f5a-9b6c-7d8e9f0a1b2c"

  it("finds the row an entry came from, as the runner names the entry", () => {
    const rows = [row("other", told, false), row(entry, ask, true)]
    expect(entryRow(rows, { id: `m-${entry.replaceAll("-", "")}` })?.id).toBe(entry)
    expect(entryRow(rows, { id: entry })?.id).toBe(entry)
  })

  it("finds nothing for an entry with no row, not another row of its terminal", () => {
    expect(entryRow([row("other", held, true)], { id: "m-gone" })).toBeUndefined()
  })
})
