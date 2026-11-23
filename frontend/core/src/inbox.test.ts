import type { ChatRequest } from "./conversation"
import {
  inboxType,
  inboxEntryOf,
  nextLimitReset,
  ordered,
  terminalDone,
  terminalNeed,
  withSnoozes,
  emptyInbox,
  noInbox,
  type InboxContent,
  type InboxEntry,
  type InboxState,
} from "./inbox"
import { createStore } from "./store"
import { describe, expect, it } from "./test"

const source: InboxEntry["source"] = {
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
    askedAt: 0,
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
const failed: InboxContent = { kind: "trouble", trouble: { type: "failed", error: null } }
const told: InboxContent = { kind: "update", update: { type: "told", subject: "s", body: "b" } }

const entry = (id: string, content: InboxContent, stopped: boolean, at = 0): InboxEntry => ({
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
  const there = (id: string, content: InboxContent, seen = false): InboxEntry => ({
    ...entry(id, content, true),
    seen,
  })
  const away = (id: string, content: InboxContent): InboxEntry => ({
    ...entry(id, content, true),
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

  it("needs nothing for trouble or updates, nor for another terminal's entries", () => {
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
    const entries = [there("a", limitAt(300, false)), there("b", limitAt(100, false))]
    expect(nextLimitReset(entries, 50)).toBe(100)
    expect(nextLimitReset(entries, 100)).toBe(300)
    expect(nextLimitReset(entries, 300)).toBeUndefined()
    expect(nextLimitReset([there("c", done)], 0)).toBeUndefined()
  })

  it("has a done once its report is unseen, and not for a tell or another terminal", () => {
    expect(terminalDone([there("a", done)], at)).toBe(true)
    expect(terminalDone([there("a", done, true)], at)).toBe(false)
    expect(terminalDone([there("a", told)], at)).toBe(false)
    expect(terminalDone([away("a", done)], at)).toBe(false)
  })
})

describe("ordered", () => {
  const settled = (id: string, at: number, resolvedAt: number): InboxEntry => ({
    ...entry(id, ask, true, at),
    settled: { how: "dismissed", at: resolvedAt },
  })

  it("puts the entry added last first, whatever it asks", () => {
    const entries = [
      entry("update", told, false, 1),
      entry("late", held, true, 20),
      entry("trouble", failed, true, 30),
      entry("early", ask, true, 10),
    ]
    expect(ordered(entries).map((each) => each.id)).toEqual(["trouble", "late", "early", "update"])
  })

  it("mixes open and resolved entries by when each was added", () => {
    const entries = [
      settled("s1", 100, 500),
      entry("open", ask, true, 200),
      settled("s2", 300, 400),
      entry("older", failed, true, 50),
    ]
    expect(ordered(entries).map((each) => each.id)).toEqual(["s2", "open", "s1", "older"])
  })

  it("lists only the ten resolved entries that resolved last, and every open one", () => {
    const resolved = Array.from({ length: 12 }, (_, index) =>
      settled(`s${index}`, 1000 + index, 2000 + index),
    )
    const entries = [...resolved, entry("a", ask, true, 1), entry("b", failed, true, 2)]
    const listed = ordered(entries).map((each) => each.id)
    expect(listed).toHaveLength(12)
    expect(listed).toContain("a")
    expect(listed).toContain("b")
    expect(listed).not.toContain("s0")
    expect(listed).not.toContain("s1")
    expect(listed).toContain("s2")
  })

  it("leaves its input as it was", () => {
    const entries = [entry("a", failed, true, 1), entry("b", told, false, 2)]
    ordered(entries)
    expect(entries.map((each) => each.id)).toEqual(["a", "b"])
  })
})

describe("inboxEntryOf", () => {
  const messageId = "8f1c2a3b-0d4e-4f5a-9b6c-7d8e9f0a1b2c"

  it("finds the Inbox entry a message came from, as the runner names the message", () => {
    const entries = [entry("other", told, false), entry(messageId, ask, true)]
    expect(inboxEntryOf(entries, { id: `m-${messageId.replaceAll("-", "")}` })?.id).toBe(messageId)
    expect(inboxEntryOf(entries, { id: messageId })?.id).toBe(messageId)
  })

  it("finds nothing for a message with no Inbox entry, not another entry of its terminal", () => {
    expect(inboxEntryOf([entry("other", held, true)], { id: "m-gone" })).toBeUndefined()
  })
})

describe("withSnoozes", () => {
  const entries = [entry("a", held, true), entry("b", held, true, 1)]
  const make = (initial: readonly string[] = []) => {
    const state = createStore<InboxState>({ ...emptyInbox, items: entries })
    const saved: (readonly string[])[] = []
    const inbox = withSnoozes({ ...noInbox, state }, initial, (keys) => saved.push(keys))
    return { state, saved, inbox }
  }
  const snoozedIds = (state: InboxState) =>
    state.items.filter((each) => each.snoozed).map((each) => each.id)

  it("marks the entries snoozed before, and nothing else", () => {
    const { inbox } = make(["b@1", "gone@3"])
    expect(snoozedIds(inbox.state.getSnapshot())).toEqual(["b"])
    // The same listing reads as the same state.
    expect(inbox.state.getSnapshot()).toBe(inbox.state.getSnapshot())
  })

  it("takes the snoozes another device left, without keeping them again", () => {
    const state = createStore<InboxState>({ ...emptyInbox, items: entries })
    const saved: (readonly string[])[] = []
    let take: (keys: readonly string[]) => void = () => {}
    const inbox = withSnoozes(
      { ...noInbox, state },
      [],
      (keys) => saved.push(keys),
      (given) => {
        take = given
      },
    )
    let changes = 0
    const stop = inbox.state.subscribe(() => changes++)
    take(["a@0"])
    expect(snoozedIds(inbox.state.getSnapshot())).toEqual(["a"])
    // The same again changes nothing.
    take(["a@0"])
    expect(changes).toBe(1)
    expect(saved).toEqual([])
    stop()
  })

  it("snoozes and brings back, tells who listens, and keeps each by its id and start", () => {
    const { inbox, saved } = make()
    let changes = 0
    const stop = inbox.state.subscribe(() => changes++)
    inbox.snooze?.("a", true)
    expect(snoozedIds(inbox.state.getSnapshot())).toEqual(["a"])
    expect(saved.at(-1)).toEqual(["a@0"])
    inbox.snooze?.("a", false)
    expect(snoozedIds(inbox.state.getSnapshot())).toEqual([])
    expect(inbox.state.getSnapshot().items[0]).not.toHaveProperty("snoozed")
    expect(saved.at(-1)).toEqual([])
    expect(changes).toBe(2)
    stop()
  })

  it("keeps a snooze while its entry is away, and keeps the snoozed entry the same", () => {
    const { inbox, state } = make(["a@0"])
    const before = inbox.state.getSnapshot().items[0]
    state.update((current) => ({ ...current, items: [...entries, entry("c", held, true, 2)] }))
    expect(inbox.state.getSnapshot().items[0]).toBe(before)
    state.update((current) => ({ ...current, items: [entries[1]!] }))
    expect(snoozedIds(inbox.state.getSnapshot())).toEqual([])
    state.update((current) => ({ ...current, items: entries }))
    expect(snoozedIds(inbox.state.getSnapshot())).toEqual(["a"])
  })

  it("leaves unsnoozed a newer entry under the same id, as a thread held again", () => {
    const { inbox, state } = make(["a@0"])
    state.update((current) => ({ ...current, items: [entry("a", held, true, 9)] }))
    expect(snoozedIds(inbox.state.getSnapshot())).toEqual([])
  })

  it("leaves unsnoozed an entry that has settled", () => {
    const { inbox, state } = make(["a@0"])
    state.update((current) => ({
      ...current,
      items: [{ ...entries[0]!, settled: { how: "dismissed", at: 5 } }],
    }))
    expect(snoozedIds(inbox.state.getSnapshot())).toEqual([])
  })

  it("is left out of a terminal's marks", () => {
    const snoozed = { ...entry("a", held, true), snoozed: true as const }
    expect(terminalNeed([entry("a", held, true)], source, 0)).toBe("unblock")
    expect(terminalNeed([snoozed], source, 0)).toBeUndefined()
  })
})
