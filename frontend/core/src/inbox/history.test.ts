import { vi } from "vitest"

import type { ChatRequest } from "../conversation"
import type { InboxEntry } from "../inbox"
import { noMessages, type AgentMessage, type MessageThread, type MessagesState } from "../messages"
import { createTerminalState } from "../state"
import { describe, expect, it } from "../test"
import type { AgentStatus, TerminalMetadata, Workspace } from "../types"
import {
  answerLine,
  createInboxHistory,
  fitted,
  keptEntry,
  parseHistory,
  type HistoryFacts,
} from "./history"

const terminal = (
  agent: AgentStatus = { working: false },
  process = "claude",
): TerminalMetadata => ({
  id: "01",
  name: "Terminal 1",
  directory: "/work/app",
  command: process,
  process,
  handle: "moth",
  state: "running",
  agent,
})

const workspaceOf = (...terminals: TerminalMetadata[]): Workspace => ({
  activeProjectId: "p",
  projects: [
    {
      id: "p",
      name: "App",
      directory: "/work/app",
      activeSessionId: "s",
      history: [
        { id: "s", name: "s", visitedAt: 0, state: createTerminalState(terminals, "grid", "grid") },
      ],
    },
  ],
})

const facts = (
  workspace: Workspace = workspaceOf(terminal()),
  messages: MessagesState = noMessages,
): HistoryFacts => ({ workspace, messages })

const source: InboxEntry["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "01",
  handle: "moth",
  agent: "claude",
  title: "Terminal 1",
  projectName: "App",
}

const request = (id: string, change: Partial<ChatRequest> = {}): InboxEntry => ({
  id: `request:${id}`,
  source,
  at: 100,
  stopped: true,
  seen: false,
  kind: "request",
  request: {
    id,
    kind: "permission",
    tool: "Bash",
    subject: "pnpm add x",
    choices: [],
    subagent: false,
    dialog: {
      type: "choices",
      id: "d1",
      title: null,
      detail: null,
      options: [
        { id: "yes", label: "Yes", text: null },
        { id: "no", label: "No", text: null },
      ],
    },
    answered: false,
    askedAt: 100,
    ...change,
  },
})

const held = (thread = "th1", at = 100): InboxEntry => ({
  id: `held:${thread}`,
  source,
  at,
  stopped: true,
  seen: false,
  kind: "held",
  held: {
    threadId: thread,
    from: { handle: "moth", title: "Terminal 1" },
    to: { handle: "fox", title: "Terminal 2" },
    text: "hi",
    hop: 3,
    heldFor: "loop",
  },
})

const trouble = (
  id: string,
  content: Extract<InboxEntry, { kind: "trouble" }>["trouble"],
  stopped = true,
): InboxEntry => ({
  id,
  source,
  at: 100,
  stopped,
  seen: false,
  kind: "trouble",
  trouble: content,
})

const waits = trouble("waits:01:100", { type: "waits", waits: "working", count: 2 })
const limit = trouble("limit:01:100", {
  type: "limit",
  minutes: 300,
  resetsAt: 9000,
  autoResume: null,
  evidence: [],
})
const failed = (stopped: boolean): InboxEntry =>
  trouble("turn:01:100", { type: "failed", error: "boom", stored: true }, stopped)

const message = (change: Partial<AgentMessage> = {}): AgentMessage => ({
  id: "m1",
  hop: 3,
  from: { kind: "agent", terminalId: "01", handle: "moth", agent: null },
  to: { kind: "agent", terminalId: "02", handle: "fox", agent: null },
  text: "hi",
  sentAt: 100,
  state: "queued",
  held: null,
  deliveredAt: null,
  ...change,
})

const messagesWith = (...messages: AgentMessage[]): MessagesState => {
  const thread: MessageThread = {
    id: "th1",
    peer: { kind: "agent", terminalId: "02", handle: "fox", agent: null },
    hops: 3,
    idle: 0,
    held: false,
    heldFor: null,
    messages,
  }
  return {
    ...noMessages,
    terminals: { "p/s/01": { terminalId: "01", handle: "moth", agent: true, threads: [thread] } },
  }
}

const clock = { now: 1000 }
const setup = () => {
  const save = vi.fn<(entries: readonly InboxEntry[]) => void>()
  clock.now = 1000
  const history = createInboxHistory({ save, now: () => (clock.now += 10) })
  return { history, save }
}

const settledOf = (entries: readonly InboxEntry[], id: string) =>
  entries.find((entry) => entry.id === id)?.settled

describe("the Inbox's history", () => {
  it("lists entries that are open as they are, and keeps them open, not resolved", () => {
    const { history, save } = setup()
    const found = [request("r1"), held()]
    expect(history.view(found, facts()).entries.map(({ id }) => id)).toEqual([
      "held:th1",
      "request:r1",
    ])
    const saved = save.mock.calls.at(-1)![0]
    expect(saved.map(({ id }) => id).toSorted()).toEqual(["held:th1", "request:r1"])
    expect(saved.every((entry) => entry.settled === undefined)).toBe(true)
  })

  describe("a dialog that is gone", () => {
    it("was answered in the terminal where its agent went on working", () => {
      const { history, save } = setup()
      history.view([request("r1")], facts())
      const working = workspaceOf(terminal({ working: true }))
      const { entries } = history.view([], facts(working))
      expect(entries).toHaveLength(1)
      expect(settledOf(entries, "request:r1")).toMatchObject({ how: "terminal" })
      expect(entries[0]).toMatchObject({ stopped: false, kind: "request" })
      expect(save.mock.calls.at(-1)![0].map(({ settled }) => settled?.how)).toEqual(["terminal"])
    })

    it("went unanswered where its agent rests, as when its turn was interrupted", () => {
      const { history } = setup()
      history.view([request("r1")], facts())
      expect(settledOf(history.view([], facts()).entries, "request:r1")).toMatchObject({
        how: "gone",
      })
    })

    it("was answered where the chat answered it, or the person did here, with their words", () => {
      const { history } = setup()
      history.view([request("r1", { answered: true }), request("r2")], facts())
      history.note("request:r2", "answered", "Yes: go ahead")
      const { entries } = history.view([], facts())
      expect(settledOf(entries, "request:r1")).toMatchObject({ how: "answered" })
      expect(settledOf(entries, "request:r1")?.answer).toBeUndefined()
      expect(settledOf(entries, "request:r2")).toMatchObject({
        how: "answered",
        answer: "Yes: go ahead",
      })
    })

    it("forgets a note taken back", () => {
      const { history } = setup()
      history.view([request("r1")], facts())
      history.note("request:r1", "answered", "Yes")
      history.forget("request:r1")
      expect(settledOf(history.view([], facts()).entries, "request:r1")).toMatchObject({
        how: "gone",
      })
    })
  })

  it("tells how a dialog ended the same for every harness", () => {
    for (const agent of ["claude", "codex", "agy"] as const) {
      const entry: InboxEntry = { ...request("r1"), source: { ...source, agent } }
      const answered = setup()
      answered.history.view([entry], facts(workspaceOf(terminal({ working: false }, agent))))
      const working = facts(workspaceOf(terminal({ working: true }, agent)))
      expect(settledOf(answered.history.view([], working).entries, "request:r1")?.how, agent).toBe(
        "terminal",
      )
      const interrupted = setup()
      interrupted.history.view([entry], facts(workspaceOf(terminal({ working: false }, agent))))
      const resting = facts(workspaceOf(terminal({ working: false }, agent)))
      expect(
        settledOf(interrupted.history.view([], resting).entries, "request:r1")?.how,
        agent,
      ).toBe("gone")
    }
  })

  it("ends every open entry with its terminal or its agent", () => {
    const { history } = setup()
    history.view([request("r1"), held(), waits, limit], facts())
    const { entries } = history.view([], facts(workspaceOf()))
    expect(entries.map((entry) => entry.settled?.how)).toEqual(["ended", "ended", "ended", "ended"])
    const other = setup()
    other.history.view([request("r1")], facts())
    const codex = workspaceOf(terminal({ working: true }, "codex"))
    expect(settledOf(other.history.view([], facts(codex)).entries, "request:r1")?.how).toBe("ended")
  })

  it("resolves a permit that stops standing as taken back, where the person took it back", () => {
    const { history } = setup()
    const permit = (id: string): InboxEntry => ({
      id: `permit:01:${id}`,
      source,
      at: 100,
      stopped: false,
      seen: false,
      kind: "permit",
      permit: {
        id,
        title: "Open a PR into main",
        quote: null,
        givenAt: 100,
        until: 900,
        usedAt: null,
      },
    })
    history.view([permit("p1"), permit("p2")], facts())
    history.note("permit:01:p1", "takenBack")
    const { entries } = history.view([], facts())

    expect(settledOf(entries, "permit:01:p1")).toMatchObject({ how: "takenBack" })
    expect(settledOf(entries, "permit:01:p2")).toMatchObject({ how: "lapsed" })
  })

  it("says whether a held message was released or its thread stopped", () => {
    const first = setup()
    first.history.view([held()], facts())
    const released = messagesWith(message({ state: "delivered" }))
    expect(
      settledOf(
        first.history.view([], facts(workspaceOf(terminal()), released)).entries,
        "held:th1",
      )?.how,
    ).toBe("released")
    const second = setup()
    second.history.view([held()], facts())
    const stopped = messagesWith(message({ state: "gone" }))
    expect(
      settledOf(
        second.history.view([], facts(workspaceOf(terminal()), stopped)).entries,
        "held:th1",
      )?.how,
    ).toBe("stopped")
    const noted = setup()
    noted.history.view([held()], facts())
    noted.history.note("held:th1", "stopped")
    expect(settledOf(noted.history.view([], facts()).entries, "held:th1")?.how).toBe("stopped")
  })

  it("delivers messages that waited, and ends a limit once the agent works again", () => {
    const { history } = setup()
    history.view([waits, limit], facts())
    const arrived = messagesWith(
      message({
        state: "delivered",
        deliveredAt: 500,
        to: { kind: "agent", terminalId: "01", handle: "moth", agent: null },
      }),
    )
    const { entries } = history.view([], facts(workspaceOf(terminal()), arrived))
    expect(settledOf(entries, waits.id)?.how).toBe("delivered")
    expect(settledOf(entries, limit.id)?.how).toBe("worked")
  })

  it("resolves a failed turn whose agent moved on, and has its stored entry read", () => {
    const { history } = setup()
    const first = history.view([failed(true)], facts())
    expect(first.read).toEqual([])
    expect(first.entries[0]?.settled).toBeUndefined()
    const next = history.view([failed(false)], facts())
    expect(next.read).toEqual(["turn:01:100"])
    expect(settledOf(next.entries, "turn:01:100")).toMatchObject({ how: "worked" })
    // Listed once, while its stored entry stands and after it is read.
    const again = history.view([failed(false)], facts())
    expect(again.entries).toHaveLength(1)
    expect(history.view([], facts()).entries).toHaveLength(1)
  })

  it("keeps an entry resolved while the listing is out to be told of it again", () => {
    const { history } = setup()
    history.view([request("r1")], facts())
    expect(history.view([], facts(), false).entries).toEqual([])
    expect(settledOf(history.view([], facts()).entries, "request:r1")).toMatchObject({
      how: "gone",
    })
  })

  it("leaves the entries the backend lists as resolved to it", () => {
    const { history } = setup()
    const ask: InboxEntry = {
      id: "ask-1",
      source,
      at: 90,
      stopped: false,
      seen: false,
      kind: "ask",
      ask: {
        subject: "Which?",
        body: "",
        details: null,
        hardToUndo: null,
        shape: { type: "text" },
      },
    }
    history.view([ask], facts())
    const listed = { ...ask, settled: { how: "answered" as const, at: 2000, answer: "A" } }
    const { entries } = history.view([listed], facts())
    expect(entries).toEqual([listed])
    expect(history.view([listed], facts()).entries).toEqual([listed])
  })

  it("takes an entry back that stands again within a moment, whatever its time then", () => {
    const { history } = setup()
    history.view([request("r1")], facts())
    expect(history.view([], facts()).entries).toHaveLength(1)
    const again: InboxEntry = { ...request("r1"), at: 120 }
    expect(history.view([again], facts()).entries).toEqual([again])
  })

  it("keeps a copy under its own id once a newer entry takes the id", () => {
    const { history } = setup()
    history.view([held("th1", 100)], facts())
    history.note("held:th1", "released")
    const { entries } = history.view([held("th1", 500)], facts())
    expect(entries.map(({ id, settled }) => [id, settled?.how])).toEqual([
      ["held:th1", undefined],
      ["held:th1~100", "released"],
    ])
  })

  it("keeps the ten entries that resolved last, and saves them", () => {
    const { history, save } = setup()
    const many = Array.from({ length: 12 }, (_, index) => request(`r${index}`))
    history.view(many, facts())
    const { entries } = history.view([], facts())
    expect(entries).toHaveLength(10)
    expect(entries.map(({ id }) => id)).not.toContain("request:r0")
    const saved = save.mock.calls.at(-1)![0]
    expect(saved.map(({ id }) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `request:r${index + 2}`),
    )
  })

  it("comes back from what it saved, and drops what can't be read", () => {
    const { history, save } = setup()
    history.view([request("r1")], facts())
    history.view([], facts())
    const kept = save.mock.calls.at(-1)![0].map(keptEntry)
    const restored = createInboxHistory({
      saved: parseHistory([...kept, "{", "[]", '{"id":"x"}']),
      save,
    })
    expect(restored.view([], facts()).entries.map(({ id }) => id)).toEqual(["request:r1"])
  })
})

describe("what the history leaves to the runner and keeps for the app", () => {
  const ask: InboxEntry = {
    id: "ask-1",
    source,
    at: 90,
    stopped: false,
    seen: false,
    kind: "ask",
    ask: { subject: "Which?", body: "", details: null, hardToUndo: null, shape: { type: "text" } },
  }

  it("makes no copy of an ask or an update that stops being listed, as its agent withdrew it", () => {
    const { history, save } = setup()
    const tell: InboxEntry = {
      ...ask,
      id: "tell-1",
      kind: "update",
      update: { type: "told", subject: "x", body: "" },
    }
    history.view([ask, tell], facts())
    const { entries } = history.view([], facts())
    expect(entries).toEqual([])
    expect(save.mock.calls.every(([kept]) => kept.length === 0)).toBe(true)
  })

  it("keeps a held message's resolved copy when the thread is held again, over several views", () => {
    const { history } = setup()
    history.view([held("th1", 100)], facts())
    history.note("held:th1", "released")
    history.view([held("th1", 500)], facts())
    for (let again = 0; again < 3; again += 1) {
      const { entries } = history.view([held("th1", 500)], facts())
      expect(entries.map(({ id, settled }) => [id, settled?.how])).toEqual([
        ["held:th1", undefined],
        ["held:th1~100", "released"],
      ])
    }
  })

  it("calls a dialog closed with no word, not interrupted, where its agent rests", () => {
    const { history } = setup()
    history.view([request("r1")], facts())
    expect(settledOf(history.view([], facts()).entries, "request:r1")?.how).toBe("gone")
  })

  it("ends an entry as session ended where its terminal is asleep", () => {
    const { history } = setup()
    history.view([limit, waits], facts())
    const asleep: TerminalMetadata = {
      id: "01",
      name: "T",
      directory: "/w",
      command: "claude",
      process: "claude",
      handle: "moth",
      state: "sleeping",
      agent: "claude",
    } as never
    const { entries } = history.view([], facts(workspaceOf(asleep)))
    expect(entries.map((entry) => entry.settled?.how)).toEqual(["ended", "ended"])
  })

  it("says waiting messages that nothing delivered were stopped or withdrawn", () => {
    const { history } = setup()
    history.view([waits], facts())
    expect(settledOf(history.view([], facts()).entries, waits.id)?.how).toBe("gone")
  })

  it("cuts long texts and lists of what it keeps, and keeps what it saves within its bytes", () => {
    const { history, save } = setup()
    const long = request("r1")
    if (long.kind !== "request" || long.request.dialog?.type !== "choices")
      throw new Error("a choices dialog")
    const big: InboxEntry = {
      ...long,
      request: { ...long.request, dialog: { ...long.request.dialog, detail: "x".repeat(300_000) } },
    }
    history.view([big], facts())
    const { entries } = history.view([], facts())
    const kept = entries[0]
    expect(
      kept?.kind === "request" &&
        kept.request.dialog?.type === "choices" &&
        kept.request.dialog.detail?.length,
    ).toBeLessThan(2100)
    expect(JSON.stringify(save.mock.calls.at(-1)![0]).length).toBeLessThan(64_000)
    const heavy = Array.from({ length: 300 }, () => kept!)
    const fits = fitted(heavy)
    expect(fits.length).toBeLessThan(300)
    expect(fits.reduce((sum, entry) => sum + keptEntry(entry).length, 0)).toBeLessThanOrEqual(
      64_000,
    )
  })

  it("resolves an entry it kept open when the app stopped, as ended while away, once steady and a moment on", () => {
    const first = setup()
    first.history.view([request("r1"), held("th1")], facts())
    const kept = first.save.mock.calls.at(-1)![0]
    const next = setup()
    const restored = createInboxHistory({
      saved: parseHistory(kept.map(keptEntry)),
      save: next.save,
      now: () => clock.now,
    })
    // Before the streams had their moment, nothing has ended.
    const early = restored.view([request("r1")], facts())
    expect(early.entries.map((entry) => entry.settled?.how)).toEqual([undefined])
    expect(early.wake).toBeGreaterThan(0)
    clock.now += 4000
    const later = restored.view([request("r1")], facts())
    expect(later.entries.map(({ id, settled }) => [id, settled?.how])).toEqual([
      ["held:th1", "away"],
      ["request:r1", undefined],
    ])
    expect(later.wake).toBeUndefined()
    // Not while it is unsteady.
    const lone = createInboxHistory({
      saved: parseHistory(kept.map(keptEntry)),
      save: next.save,
      now: () => clock.now,
    })
    clock.now += 4000
    expect(lone.view([], facts(), false).entries).toEqual([])
  })
})

describe("the line a dialog's answer makes", () => {
  const permission =
    request("r1").kind === "request"
      ? (request("r1") as Extract<InboxEntry, { kind: "request" }>).request
      : undefined

  it("names the option and the words the person added", () => {
    expect(answerLine(permission!, { type: "choice", dialog: "d1", option: "yes" })).toBe("Yes")
    expect(
      answerLine(permission!, { type: "choice", dialog: "d1", option: "no", text: " not now " }),
    ).toBe("No: not now")
  })

  it("names the options picked for each question, and what became of a form or a chat", () => {
    const question: ChatRequest = {
      ...permission!,
      kind: "question",
      dialog: {
        type: "questions",
        id: "q",
        chat: null,
        questions: [
          {
            id: "q1",
            header: null,
            question: "Route?",
            options: [{ id: "a", label: "Fast", description: null }],
            multiSelect: false,
            text: true,
          },
        ],
      },
    }
    expect(
      answerLine(question, {
        type: "questions",
        dialog: "q",
        answers: [{ question: "q1", options: ["a"], text: "soon" }],
      }),
    ).toBe("Fast, soon")
    expect(answerLine(question, { type: "chat", dialog: "q" })).toBe(
      "Set aside to talk it over in the terminal",
    )
    expect(answerLine(question, { type: "form", dialog: "q", action: "decline", values: {} })).toBe(
      "Declined the form",
    )
  })
})
