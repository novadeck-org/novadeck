import { finishGraceMs } from "@novadeck/core/agents/finish"
import {
  inboxType,
  ordered,
  type InboxAnswer,
  type InboxEntry,
  type InboxTurn,
} from "@novadeck/core/inbox"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore } from "@novadeck/core/store"
import type { AgentTurnEnd, TerminalMetadata } from "@novadeck/core/types"
import { afterEach, beforeEach, vi } from "vitest"

import { answerMs as chatAnswerMs, answeredMs } from "./agents/chat"
import { demoTurnMs, demoTurns } from "./agents/turns"
import { answerMs, createDemoInbox, isDemoInbox } from "./inbox"
import { demoInboxIds, demoInboxEntries, demoInboxEntriesAll } from "./inbox/fixtures"
import { plainDemo, type PlainVariant } from "./index"
import { chatAgent, demoTerminalId } from "./samples"
import { context, describe, expect, it } from "./test"
import { createDemo, demoVariants } from "./variants"
import { terminalOf as terminalIn } from "./workspace"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const now = 1_000_000_000_000

// The entries that are still open; the resolved ones stay listed beside them, as history.
const ids = (inbox: ReturnType<typeof createDemoInbox>): string[] =>
  inbox.state
    .getSnapshot()
    .items.filter((each) => !each.settled)
    .map((each) => each.id)

const resolvedOf = (inbox: ReturnType<typeof createDemoInbox>, id: string) =>
  inbox.state.getSnapshot().items.find((each) => each.id === id)?.settled

describe("the demo Inbox's entries", () => {
  it("covers every type, each kind and every ask shape", () => {
    // The list starts with most of them; the debug panel adds the rest.
    const entries = demoInboxEntriesAll(now)
    expect(new Set(entries.map(inboxType))).toEqual(
      new Set(["unblock", "ask", "trouble", "update"]),
    )
    expect(new Set(entries.map((each) => each.kind))).toEqual(
      new Set(["request", "held", "ask", "trouble", "update"]),
    )
    const shapes = entries.flatMap((each) => (each.kind === "ask" ? [each.ask.shape.type] : []))
    expect(new Set(shapes)).toEqual(new Set(["options", "action", "text", "newer"]))
    const troubles = entries.flatMap((each) => (each.kind === "trouble" ? [each.trouble.type] : []))
    expect(new Set(troubles)).toEqual(new Set(["stuck", "limit", "failed", "waits"]))
    const requests = entries.flatMap((each) => (each.kind === "request" ? [each.request.kind] : []))
    expect(new Set(requests)).toEqual(new Set(["permission", "question", "plan"]))
    const updates = entries.flatMap((each) => (each.kind === "update" ? [each.update.type] : []))
    expect(new Set(updates)).toEqual(new Set(["done", "told", "newer"]))
  })

  it("presents an ask whose answer is an action as an unblock, and a question as an ask", () => {
    const entries = demoInboxEntriesAll(now)
    const typeOf = (id: string) => inboxType(entries.find((each) => each.id === id)!)
    expect(typeOf(demoInboxIds.login)).toBe("unblock")
    expect(typeOf(demoInboxIds.question)).toBe("ask")
    expect(typeOf(demoInboxIds.done)).toBe("update")
  })

  it("puts one entry on each sample terminal, none seen, none from the future", () => {
    // The states the debug panel adds too: each on a terminal of its own, but for a held
    // message, which is its thread's, and messages held long, which are the terminal's
    // alongside whatever else it shows.
    const entries = demoInboxEntriesAll(now).filter(
      (each) => each.kind !== "held" && !(each.kind === "trouble" && each.trouble.type === "waits"),
    )
    const terminals = entries.map((each) => each.source.terminalId)
    expect(new Set(terminals).size).toBe(terminals.length)
    expect(entries.every((each) => !each.seen && each.at <= now)).toBe(true)
  })

  it("gives the Codex permission Codex's own options", () => {
    const codex = demoInboxEntries(now).find((each) => each.id === demoInboxIds.codexPermission)
    const dialog = codex?.kind === "request" ? codex.request.dialog : null
    expect(dialog?.type === "choices" ? dialog.options.map((each) => each.label) : []).toEqual([
      "Yes, proceed",
      "Yes, and don't ask again for commands that start with `pnpm add`",
      "No, continue without running it",
      "No, and tell Codex what to do differently",
    ])
  })
})

describe("the demo Inbox", () => {
  context("when the next answer is made to fail", () => {
    it("keeps the entry and says why, then answers normally", () => {
      const inbox = createDemoInbox(now)
      inbox.failNext()
      inbox.answer(demoInboxIds.held, { kind: "held", action: "release" })
      vi.advanceTimersByTime(answerMs)
      expect(ids(inbox)).toContain(demoInboxIds.held)
      expect(inbox.state.getSnapshot().failed[demoInboxIds.held]).toMatch(/Try again/)

      inbox.answer(demoInboxIds.held, { kind: "held", action: "release" })
      vi.advanceTimersByTime(answerMs)
      expect(ids(inbox)).not.toContain(demoInboxIds.held)
      expect(resolvedOf(inbox, demoInboxIds.held)).toMatchObject({ how: "released" })
    })
  })

  context("when an answer is sent", () => {
    it("marks the entry answering, then removes it", () => {
      const inbox = createDemoInbox(now)
      inbox.answer(demoInboxIds.held, { kind: "held", action: "release" })
      expect(inbox.state.getSnapshot().answering).toEqual({ [demoInboxIds.held]: true })
      expect(ids(inbox)).toContain(demoInboxIds.held)
      vi.advanceTimersByTime(answerMs)
      expect(inbox.state.getSnapshot().answering).toEqual({})
      expect(ids(inbox)).not.toContain(demoInboxIds.held)
    })

    it("ignores an entry that is not there", () => {
      const inbox = createDemoInbox(now)
      const before = inbox.state.getSnapshot()
      inbox.answer("nothing", { kind: "held", action: "stop" })
      expect(inbox.state.getSnapshot()).toBe(before)
    })

    it("fails an answer meant for another kind of entry, leaving the entry", () => {
      const inbox = createDemoInbox(now)
      inbox.answer(demoInboxIds.held, { kind: "update", action: "read" })
      vi.advanceTimersByTime(answerMs)
      expect(ids(inbox)).toContain(demoInboxIds.held)
      expect(Object.keys(inbox.state.getSnapshot().failed)).toEqual([demoInboxIds.held])
    })
  })

  context("when auto-resume is turned off at a limit", () => {
    it("keeps the entry, now waiting on the person", () => {
      const inbox = createDemoInbox(now)
      inbox.answer(demoInboxIds.limit, {
        kind: "trouble",
        action: { type: "auto-resume", on: false },
      })
      vi.advanceTimersByTime(answerMs)
      const limit = inbox.state.getSnapshot().items.find((each) => each.id === demoInboxIds.limit)
      expect(limit?.stopped).toBe(true)
      expect(limit?.kind === "trouble" && limit.trouble.type === "limit").toBe(true)
      expect(
        limit?.kind === "trouble" && limit.trouble.type === "limit" && limit.trouble.autoResume,
      ).toBe(false)
      expect(inbox.state.getSnapshot().answering).toEqual({})
    })
  })

  context("when auto-resume is turned on after a failed answer", () => {
    it("clears the error", () => {
      const inbox = createDemoInbox(now)
      inbox.failNext()
      inbox.answer(demoInboxIds.limit, {
        kind: "trouble",
        action: { type: "auto-resume", on: false },
      })
      expect(inbox.state.getSnapshot().failed[demoInboxIds.limit]).toBeDefined()

      inbox.answer(demoInboxIds.limit, {
        kind: "trouble",
        action: { type: "auto-resume", on: false },
      })
      expect(inbox.state.getSnapshot().failed[demoInboxIds.limit]).toBeUndefined()
    })
  })

  context("when an entry is seen", () => {
    it("marks only that entry", () => {
      const inbox = createDemoInbox(now)
      inbox.see(demoInboxIds.stuck)
      const seen = inbox.state.getSnapshot().items.filter((each) => each.seen)
      expect(seen.map((each) => each.id)).toEqual([demoInboxIds.stuck])
    })
  })

  context("when an update is read", () => {
    it("stays, resolved, and nothing that waits is touched", () => {
      const inbox = createDemoInbox(now)
      const waiting = demoInboxEntries(now).filter((each) => each.kind !== "update")
      for (const update of demoInboxEntries(now).filter((each) => each.kind === "update"))
        inbox.answer(update.id, { kind: "update", action: "read" })
      vi.advanceTimersByTime(answerMs)
      expect(ids(inbox)).toEqual(ordered(waiting).map((each) => each.id))
      expect(resolvedOf(inbox, demoInboxIds.told)).toMatchObject({ how: "read" })
      expect(resolvedOf(inbox, demoInboxIds.done)).toMatchObject({ how: "read" })
    })
  })

  context("when the person answers one of its own entries", () => {
    it("resolves it with the answer: an option, a dialog's words, or a thread stopped", () => {
      const inbox = createDemoInbox(now)
      inbox.answer(demoInboxIds.webhook, {
        kind: "ask",
        answer: { type: "reply", option: 1, text: "Mind the backoff." },
      })
      inbox.answer(demoInboxIds.held, { kind: "held", action: "stop" })
      vi.advanceTimersByTime(answerMs)

      expect(resolvedOf(inbox, demoInboxIds.webhook)).toMatchObject({
        how: "answered",
        answer: "Our own retries: 6 tries with backoff over an hour: Mind the backoff.",
      })
      expect(resolvedOf(inbox, demoInboxIds.held)).toMatchObject({ how: "stopped" })
      expect(
        inbox.state.getSnapshot().items.find(({ id }) => id === demoInboxIds.held),
      ).toMatchObject({
        stopped: false,
      })
    })
  })

  context("when an entry arrives", () => {
    it("joins the Inbox, replacing one with its ID, until it is cleared", () => {
      const inbox = createDemoInbox(now, [])
      const [first] = demoInboxEntries(now) as [InboxEntry]
      inbox.add(first)
      inbox.add({ ...first, at: now + 1 })
      expect(inbox.state.getSnapshot().items).toEqual([{ ...first, at: now + 1 }])
      inbox.empty()
      expect(ids(inbox)).toEqual([])
    })
  })
})

describe("the demo variants' Inbox", () => {
  it("is in every variant", () => {
    for (const variant of demoVariants) expect(isDemoInbox(createDemo(variant).inbox)).toBe(true)
  })
})

// A plain demo the app has opened, its Inbox bound to the workspace as the app binds it.
const boot = (variant: PlainVariant = "agents") => {
  const turns = demoTurns()
  const backend = plainDemo(variant, undefined, undefined, turns)
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 0 }),
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  backend.start!({ dispatch: (actions) => store.transact(actions as never), open: () => {} })
  const { inbox } = backend
  if (!isDemoInbox(inbox)) throw new Error("every demo has the demo's Inbox")
  const unbind = inbox.bind!({ workspace: store })
  const terminalOf = (projectId: string, slot: number): TerminalMetadata | undefined =>
    store
      .getSnapshot()
      .projects.find((project) => project.id === projectId)
      ?.history[0]?.state.roster.terminals.find(
        (terminal) =>
          terminal.id === demoTerminalId({ projectId, workspaceSessionId: "initial" }, slot),
      )
  const rowOn = (projectId: string, slot: number): InboxEntry | undefined =>
    inbox.state
      .getSnapshot()
      .items.find(
        (entry) => !entry.settled && entry.source.terminalId === terminalOf(projectId, slot)?.id,
      )
  // An agent's turn ends as the terminal's status says, a completed one standing past the
  // grace that tells it a finish.
  let ends = 0
  const finish = async (
    projectId: string,
    slot: number,
    outcome: "completed" | "failed" = "completed",
    more: Partial<AgentTurnEnd> = {},
  ): Promise<readonly InboxTurn[]> => {
    const before = new Set(inbox.turns?.getSnapshot()?.map((entry) => entry.id))
    const terminal = terminalOf(projectId, slot)
    if (terminal?.state !== "running") throw new Error("a running terminal")
    ends += 1
    store.transact([
      {
        type: "terminal/status",
        target: { projectId, workspaceSessionId: "initial" },
        terminalId: terminal.id,
        status: {
          state: "running",
          agent: {
            ...terminal.agent,
            working: false,
            lastTurn: {
              outcome,
              reply: `Reply ${ends}`,
              ...(outcome === "failed" ? { error: "stream disconnected" } : {}),
              at: Date.now() + ends,
              ...more,
            },
          },
        },
      },
    ] as never)
    await vi.advanceTimersByTimeAsync(finishGraceMs + 1)
    return (inbox.turns?.getSnapshot() ?? []).filter((entry) => !before.has(entry.id))
  }
  return { backend, inbox, store, unbind, terminalOf, rowOn, finish, turns }
}

// The entry of this id the Inbox shows.
const rowWith = (inbox: ReturnType<typeof createDemoInbox>, id: string): InboxEntry | undefined =>
  inbox.state.getSnapshot().items.find((each) => each.id === id && !each.settled)

const waitsOn = (terminal: TerminalMetadata | undefined) =>
  terminal?.state === "running" ? terminal.agent?.attention?.kind : undefined

// The first option of a request's dialog, as the person would pick it.
const firstChoice = (entry: InboxEntry | undefined): InboxAnswer => {
  if (entry?.kind !== "request" || entry.request.dialog?.type !== "choices")
    throw new Error("not a dialog of choices")
  const { dialog } = entry.request
  return {
    kind: "request",
    answer: { type: "choice", dialog: dialog.id, option: dialog.options[0]!.id },
  }
}

describe("the agents demo's Inbox", () => {
  it("keeps an agent's open asks when an Inbox button sends it a fixed line", async () => {
    const { backend, inbox, store } = boot()
    const found = store
      .getSnapshot()
      .projects.flatMap((project) =>
        (project.history[0]?.state.roster.terminals ?? []).map((terminal) => ({
          project: project.id,
          terminal,
        })),
      )
      .find(
        ({ terminal }) =>
          terminal.state === "running" &&
          chatAgent(terminal) &&
          !terminal.agent?.working &&
          !terminal.agent?.attention &&
          !inbox.state.getSnapshot().items.some((each) => each.source.terminalId === terminal.id),
      )!
    const key = {
      projectId: found.project,
      workspaceSessionId: "initial",
      terminalId: found.terminal.id,
    }
    const question = demoInboxEntriesAll(now).find((each) => each.kind === "ask")!
    inbox.add({ ...question, id: "ask-here", source: { ...question.source, ...key } })
    await backend.conversations!.send(key, "continue", { automatic: true })
    await vi.advanceTimersByTimeAsync(1)
    expect(ids(inbox)).toContain("ask-here")
  })

  it("keeps an Inbox line's mark through an interrupt that gives the line back, as the runner does", async () => {
    const { backend, inbox, store, turns } = boot()
    const found = store
      .getSnapshot()
      .projects.flatMap((project) =>
        (project.history[0]?.state.roster.terminals ?? []).map((terminal) => ({
          project: project.id,
          terminal,
        })),
      )
      .find(
        ({ terminal }) =>
          terminal.state === "running" &&
          chatAgent(terminal) &&
          terminal.agent !== undefined &&
          !terminal.agent?.working &&
          !terminal.agent?.attention &&
          !inbox.state.getSnapshot().items.some((each) => each.source.terminalId === terminal.id),
      )!
    const key = {
      projectId: found.project,
      workspaceSessionId: "initial",
      terminalId: found.terminal.id,
    }
    const question = demoInboxEntriesAll(now).find((each) => each.kind === "ask")!
    // The agent works, and a Continue waits behind its turn; the person takes the line back.
    expect(turns.prompt("Get on with it.", found.terminal, key)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await backend.conversations!.send(key, "continue", { automatic: true })
    expect(await backend.conversations!.interrupt(key)).toEqual({ words: "continue" })
    inbox.add({ ...question, id: "ask-here", source: { ...question.source, ...key } })
    // Sent again as their own words, the line still matches the mark, which waited.
    await vi.advanceTimersByTimeAsync(5_000)
    await backend.conversations!.send(key, "continue")
    await vi.advanceTimersByTimeAsync(1)
    expect(ids(inbox)).toContain("ask-here")
  })

  it("settles an agent's open asks as replied when the person writes to it, and no other entry", async () => {
    const { inbox, turns, store } = boot()
    const found = store
      .getSnapshot()
      .projects.flatMap((project) =>
        (project.history[0]?.state.roster.terminals ?? []).map((terminal) => ({
          project: project.id,
          terminal,
        })),
      )
      .find(
        ({ terminal }) =>
          terminal.state === "running" &&
          chatAgent(terminal) &&
          terminal.agent !== undefined &&
          !terminal.agent?.working &&
          !terminal.agent?.attention &&
          !inbox.state.getSnapshot().items.some((each) => each.source.terminalId === terminal.id),
      )!
    const key = {
      projectId: found.project,
      workspaceSessionId: "initial",
      terminalId: found.terminal.id,
    }
    const all = demoInboxEntriesAll(now)
    const question = all.find((each) => each.kind === "ask")!
    const update = all.find((each) => each.kind === "update")!
    const here = { ...question.source, ...key }
    inbox.add({ ...question, id: "ask-here", source: here })
    inbox.add({ ...question, id: "ask-elsewhere" })
    inbox.add({ ...update, id: "update-here", source: { ...update.source, ...key } })
    expect(ids(inbox)).toEqual(expect.arrayContaining(["ask-here", "update-here", "ask-elsewhere"]))
    // An ask made after a prompt was queued (the demo's lasts from `now`) stays.
    inbox.add({ ...question, id: "ask-later", at: now + 5, source: here })
    expect(turns.prompt("Blue, please.", found.terminal, key, { submittedAt: now + 1 })).toBe(true)
    const entry = (id: string) => inbox.state.getSnapshot().items.find((each) => each.id === id)!
    // Open until the agent is told, within its turn.
    await vi.advanceTimersByTimeAsync(1)
    expect(entry("ask-here").settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(demoTurnMs)
    expect(ids(inbox)).toContain("ask-later")
    const left = ids(inbox)
    // It stays, settled; an ask on another terminal, and an update on this one, are as they were.
    expect(entry("ask-here").settled).toMatchObject({ how: "replied" })
    expect(entry("ask-elsewhere").settled).toBeUndefined()
    expect(entry("update-here").settled).toBeUndefined()
    expect(left).toEqual(expect.arrayContaining(["update-here", "ask-elsewhere"]))
  })

  it("leaves an agent's open asks open when the turn on the person's words stops before it is told", async () => {
    const { inbox, turns, store, backend } = boot()
    const found = store
      .getSnapshot()
      .projects.flatMap((project) =>
        (project.history[0]?.state.roster.terminals ?? []).map((terminal) => ({
          project: project.id,
          terminal,
        })),
      )
      .find(
        ({ terminal }) =>
          terminal.state === "running" &&
          chatAgent(terminal) &&
          terminal.agent !== undefined &&
          !terminal.agent.working &&
          !terminal.agent.attention &&
          !inbox.state.getSnapshot().items.some((each) => each.source.terminalId === terminal.id),
      )!
    const key = {
      projectId: found.project,
      workspaceSessionId: "initial",
      terminalId: found.terminal.id,
    }
    const question = demoInboxEntriesAll(now).find((each) => each.kind === "ask")!
    inbox.add({ ...question, id: "ask-here", source: { ...question.source, ...key } })
    expect(turns.prompt("Blue, please.", found.terminal, key, { submittedAt: now + 1 })).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await backend.conversations!.interrupt(key)
    await vi.advanceTimersByTimeAsync(demoTurnMs * 2)
    const entry = inbox.state.getSnapshot().items.find((each) => each.id === "ask-here")!
    expect(entry.settled).toBeUndefined()
  })

  it("leaves an agent's open asks open when its turn on the person's words is taken another way", async () => {
    const { inbox, turns, store, backend } = boot()
    const terminalAt = () => terminalIn(store.getSnapshot(), key)!
    const found = store
      .getSnapshot()
      .projects.flatMap((project) =>
        (project.history[0]?.state.roster.terminals ?? []).map((terminal) => ({
          project: project.id,
          terminal,
        })),
      )
      .find(
        ({ terminal }) =>
          terminal.state === "running" &&
          chatAgent(terminal) &&
          terminal.agent !== undefined &&
          !terminal.agent.working &&
          !terminal.agent.attention &&
          !inbox.state.getSnapshot().items.some((each) => each.source.terminalId === terminal.id),
      )!
    const key = {
      projectId: found.project,
      workspaceSessionId: "initial",
      terminalId: found.terminal.id,
    }
    const question = demoInboxEntriesAll(now).find((each) => each.kind === "ask")!
    inbox.add({ ...question, id: "ask-here", source: { ...question.source, ...key } })
    expect(turns.prompt("Blue, please.", found.terminal, key, { submittedAt: now + 1 })).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    // The debug panel has it ask, which ends the turn; answered, it goes on to a reply.
    turns.ask(key, terminalAt(), "question", 1)
    const [request] = backend.conversations!.conversation(key).getSnapshot().requests
    const dialog = request!.dialog!
    if (dialog.type !== "questions") throw new Error("A question asks with questions")
    const answering = backend.conversations!.answer(key, request!.id, {
      type: "questions",
      dialog: dialog.id,
      answers: [
        { question: dialog.questions[0]!.id, options: [dialog.questions[0]!.options[0]!.id] },
      ],
    })
    await vi.advanceTimersByTimeAsync(demoTurnMs * 3)
    await answering
    expect(terminalAt()).toMatchObject({ agent: { lastTurn: { outcome: "completed" } } })
    const entry = inbox.state.getSnapshot().items.find((each) => each.id === "ask-here")!
    expect(entry.settled).toBeUndefined()
  })

  it("dismisses an open ask in place, and lets its agent withdraw one or end its session", async () => {
    const { inbox } = boot()
    const all = demoInboxEntriesAll(now)
    const question = all.find((each) => each.kind === "ask")!
    inbox.add({ ...question, id: "ask-a" })
    inbox.add({ ...question, id: "ask-b" })
    const entry = (id: string) => inbox.state.getSnapshot().items.find((each) => each.id === id)
    inbox.dismiss!("ask-a")
    expect(entry("ask-a")?.settled).toMatchObject({ how: "dismissed" })
    expect(entry("ask-a")?.stopped).toBe(false)
    expect(ids(inbox)).not.toContain("ask-a")
    // A withdrawn ask leaves the Inbox, as the runner's does; one whose agent's session ended
    // stays, resolved.
    inbox.resolve("ask-b", "withdrawn")
    expect(entry("ask-b")).toBeUndefined()
    inbox.add({ ...question, id: "ask-c" })
    inbox.resolve("ask-c", "gone")
    expect(entry("ask-c")?.settled).toMatchObject({ how: "ended" })
    // A resolved ask cannot be answered or dismissed again.
    inbox.answer("ask-c", { kind: "ask", answer: { type: "reply", option: null, text: "x" } })
    inbox.dismiss!("ask-c")
    expect(entry("ask-c")?.settled).toMatchObject({ how: "ended" })
  })

  it("leaves an ask open, with no answer error, when its dismissal fails", () => {
    const { inbox } = boot()
    const question = demoInboxEntriesAll(now).find((each) => each.kind === "ask")!
    inbox.add({ ...question, id: "ask-a" })
    inbox.failNext()
    inbox.dismiss!("ask-a")
    const state = inbox.state.getSnapshot()
    expect(state.failed["ask-a"]).toBeUndefined()
    expect(state.items.find((each) => each.id === "ask-a")?.settled).toBeUndefined()
    inbox.dismiss!("ask-a")
    expect(
      inbox.state.getSnapshot().items.find((each) => each.id === "ask-a")?.settled,
    ).toBeDefined()
  })

  it("makes no entry of the draft an Ask made, nor of the agent's finish, beside a held thread", async () => {
    const { backend, inbox, rowOn, store, finish } = boot()
    const found = store
      .getSnapshot()
      .projects.flatMap((project) =>
        (project.history[0]?.state.roster.terminals ?? []).map((terminal) => ({
          project: project.id,
          terminal,
        })),
      )
      .find(
        ({ project, terminal }) =>
          terminal.state === "running" &&
          chatAgent(terminal) &&
          !terminal.agent?.working &&
          !terminal.agent?.attention &&
          !inbox.state.getSnapshot().items.some((each) => each.source.terminalId === terminal.id) &&
          project !== "",
      )!
    const key = {
      projectId: found.project,
      workspaceSessionId: "initial",
      terminalId: found.terminal.id,
    }
    await backend.feedback!.ask!(key, "")
    await vi.advanceTimersByTimeAsync(3 * 1500 + 100)
    // The writing turn ended unseen: the agent finished while the person looked elsewhere, and
    // the demo stored its finish as an entry, which is no Inbox entry.
    await finish(found.project, Number(found.terminal.id.slice(-2)))
    const held = demoInboxEntriesAll(now).find((each) => each.id === demoInboxIds.held)!
    inbox.add({
      ...held,
      id: "held-here",
      source: { ...held.source, terminalId: found.terminal.id },
    })
    const kinds = inbox.state
      .getSnapshot()
      .items.filter((each) => each.source.terminalId === found.terminal.id)
      .map((each) => each.kind)
    expect(kinds).toEqual(["held", ...kinds.filter((kind) => kind !== "held")])
    expect(kinds).not.toContain("update")
    expect(rowOn(found.project, Number(found.terminal.id.slice(-2)))).toBeDefined()
  })

  it("lists what each of its agents waits on, as their terminals say", () => {
    const { rowOn, inbox } = boot()
    for (const [project, slot, kind] of [
      ["storefront", 1, "plan"],
      ["storefront", 4, "permission"],
      ["api-service", 1, "plan"],
      ["api-service", 4, "permission"],
      ["docs-site", 1, "question"],
    ] as const) {
      const entry = rowOn(project, slot)
      expect(entry?.kind === "request" && entry.request.kind, `${project} ${slot}`).toBe(kind)
    }
    expect(inbox.state.getSnapshot().items.every((entry) => entry.kind === "request")).toBe(true)
  })

  context("when a request is answered", () => {
    it("moves its agent on, as an answer on its screen does, and the entry goes", async () => {
      const { inbox, rowOn, terminalOf } = boot()
      const codex = rowOn("storefront", 4)
      expect(waitsOn(terminalOf("storefront", 4))).toBe("permission")

      inbox.answer(codex!.id, firstChoice(codex))
      expect(inbox.state.getSnapshot().answering[codex!.id]).toBe(true)
      await vi.advanceTimersByTimeAsync(chatAnswerMs + answeredMs)

      expect(waitsOn(terminalOf("storefront", 4))).toBeUndefined()
      expect(rowOn("storefront", 4)).toBeUndefined()
    })

    it("says why where the answer didn't take, and keeps the entry", async () => {
      const { inbox, rowOn } = boot()
      const codex = rowOn("storefront", 4)!
      inbox.failNext()
      inbox.answer(codex.id, firstChoice(codex))
      await vi.advanceTimersByTimeAsync(0)
      expect(inbox.state.getSnapshot().failed[codex.id]).toMatch(/Try again/)
      expect(rowOn("storefront", 4)?.id).toBe(codex.id)
    })
  })

  context("when an agent finished while the person looked elsewhere", () => {
    it("stores its reply as a finished turn that marks its tab, and lists no entry", async () => {
      const { inbox, finish } = boot()
      await vi.advanceTimersByTimeAsync(10_000)
      const [entry] = await finish("design-system", 1)
      expect(entry).toMatchObject({ projectId: "design-system", outcome: "completed" })
      expect(rowWith(inbox, entry!.id)).toBeUndefined()

      inbox.readFinishes?.([{ context: "design-system/initial", terminalId: entry!.terminalId }])
      expect(inbox.turns?.getSnapshot()?.some((each) => each.id === entry!.id)).toBe(false)
    })

    it("records no entry for an end that hit a usage limit", async () => {
      const { finish } = boot()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(await finish("design-system", 1, "failed", { limited: true })).toEqual([])
      expect(
        await finish("design-system", 1, "failed", { limit: { minutes: 60, resetsAt: 9e12 } }),
      ).toEqual([])
    })

    it("lists every end as its own entry, and records one only after the grace", async () => {
      const { inbox, finish, store, terminalOf } = boot()
      await vi.advanceTimersByTimeAsync(10_000)
      const first = await finish("design-system", 1)
      const second = await finish("design-system", 1)
      expect([first.length, second.length]).toEqual([1, 1])
      expect(first[0]!.id).not.toBe(second[0]!.id)
      const listed = (): number => inbox.turns?.getSnapshot()?.length ?? 0
      const before = listed()

      // An end the person's Escape may still settle is no finish until the grace is out.
      const terminal = terminalOf("design-system", 2)!
      if (terminal.state !== "running") throw new Error("a running terminal")
      store.transact([
        {
          type: "terminal/status",
          target: { projectId: "design-system", workspaceSessionId: "initial" },
          terminalId: terminal.id,
          status: {
            state: "running",
            agent: {
              ...terminal.agent,
              working: false,
              lastTurn: { outcome: "completed", reply: "Almost", at: Date.now() + 999 },
            },
          },
        },
      ] as never)
      await vi.advanceTimersByTimeAsync(finishGraceMs - 100)
      expect(listed()).toBe(before)
      await vi.advanceTimersByTimeAsync(101)
      expect(listed()).toBe(before + 1)
    })

    it("drops a terminal's entries when the person reads its finishes", async () => {
      const { inbox, finish, terminalOf } = boot()
      await vi.advanceTimersByTimeAsync(10_000)
      const [kept] = await finish("infra", 1)
      const [read] = await finish("design-system", 1)
      inbox.readFinishes?.([
        { context: "design-system/initial", terminalId: terminalOf("design-system", 1)!.id },
      ])
      const left = inbox.turns?.getSnapshot()?.map((entry) => entry.id)
      expect(left).toContain(kept!.id)
      expect(left).not.toContain(read!.id)
    })

    it("drops the entries of a terminal that closed", async () => {
      const { inbox, finish, store, terminalOf } = boot()
      await vi.advanceTimersByTimeAsync(10_000)
      const [entry] = await finish("design-system", 1)
      const closing = terminalOf("design-system", 1)!
      store.transact([
        {
          type: "terminal/close",
          target: { projectId: "design-system", workspaceSessionId: "initial" },
          terminalId: closing.id,
        },
      ] as never)
      expect(terminalOf("design-system", 1)).toBeUndefined()
      expect(inbox.turns?.getSnapshot()?.some((each) => each.id === entry!.id)).toBe(false)
    })
  })

  context("when trouble is answered and its entry stays", () => {
    it("holds its buttons a moment, then gives them back", async () => {
      const { inbox, finish } = boot()
      await vi.advanceTimersByTimeAsync(10_000)
      const [made] = await finish("infra", 1, "failed")
      const trouble = rowWith(inbox, made!.id)!
      expect(trouble).toMatchObject({ kind: "trouble", trouble: { type: "failed" } })

      inbox.answer(trouble.id, { kind: "trouble", action: { type: "stop" } })
      await vi.advanceTimersByTimeAsync(0)
      expect(rowWith(inbox, trouble.id)).toBeDefined()
      expect(inbox.state.getSnapshot().answering[trouble.id]).toBe(true)
      await vi.advanceTimersByTimeAsync(3000)
      expect(inbox.state.getSnapshot().answering[trouble.id]).toBeUndefined()
    })
  })

  context("when an entry is seen", () => {
    it("marks only that entry", () => {
      const { inbox, rowOn } = boot()
      const codex = rowOn("storefront", 4)!
      inbox.see(codex.id)
      const seen = inbox.state.getSnapshot().items.filter((each) => each.seen)
      expect(seen.map((each) => each.id)).toEqual([codex.id])
    })
  })

  context("when the app unbinds it", () => {
    it("empties of what the agents wait on, and of the entries it stored", async () => {
      const { inbox, unbind, finish } = boot()
      await vi.advanceTimersByTimeAsync(10_000)
      await finish("design-system", 1)
      unbind()
      expect(inbox.state.getSnapshot().items).toEqual([])
      expect(inbox.turns?.getSnapshot()).toBeUndefined()
    })

    it("forgets what it knew of their entries, once bound again", async () => {
      const { inbox, rowOn, unbind, store } = boot()
      const codex = rowOn("storefront", 4)!
      inbox.see(codex.id)
      inbox.failNext()
      inbox.answer(codex.id, firstChoice(codex))
      await vi.advanceTimersByTimeAsync(0)
      unbind()

      inbox.bind!({ workspace: store })
      const again = rowOn("storefront", 4)
      expect(again).toMatchObject({ id: codex.id, seen: false })
      expect(inbox.state.getSnapshot().failed).toEqual({})
    })
  })

  context("when the workspace changes in a way no entry shows", () => {
    it("keeps the Inbox as it was", () => {
      const { inbox, store, terminalOf } = boot()
      const before = inbox.state.getSnapshot()
      store.transact([
        {
          type: "terminal/rename",
          target: { projectId: "storefront", workspaceSessionId: "initial" },
          terminalId: terminalOf("storefront", 2)!.id,
          name: "Renamed",
        },
      ] as never)
      expect(inbox.state.getSnapshot()).toBe(before)
    })
  })

  it("names each request by its terminal, so the same sample in two sessions is two entries", () => {
    const { rowOn, terminalOf } = boot()
    const codex = rowOn("storefront", 4)
    expect(codex?.id).toContain(terminalOf("storefront", 4)!.id)
  })
})

describe("the Inbox demo's own entries", () => {
  it("take the place of a dialog their terminal's agent shows, and only that", () => {
    const { inbox, terminalOf } = boot("inbox")
    const entries = inbox.state.getSnapshot().items
    const on = (terminalId: string) =>
      entries.filter((each) => each.source.terminalId === terminalId)
    const codex = terminalOf("storefront", 4)!.id
    expect(
      on(codex)
        .filter((each) => each.kind === "request")
        .map((each) => each.id),
    ).toEqual([demoInboxIds.codexPermission])
    const standing = new Set(
      entries
        .filter((each) => !each.id.startsWith("request:") && each.kind !== "held")
        .filter((each) => each.kind !== "update")
        .map((each) => each.source.terminalId),
    )
    for (const terminalId of standing)
      expect(on(terminalId).filter((each) => each.id.startsWith("request:"))).toEqual([])
  })

  it("take the agent past what it waited on once answered", async () => {
    const { inbox, terminalOf } = boot("inbox")
    const codex = inbox.state
      .getSnapshot()
      .items.find((each) => each.id === demoInboxIds.codexPermission)
    inbox.answer(demoInboxIds.codexPermission, firstChoice(codex))
    await vi.advanceTimersByTimeAsync(answerMs)
    expect(waitsOn(terminalOf("storefront", 4))).toBeUndefined()
  })
})

describe("an agent that calls done", () => {
  const report = { subject: "Search rebuilt", body: "All 412 pages, no broken links." }
  const updateOn = (found: ReturnType<typeof boot>): InboxEntry | undefined =>
    found.inbox.state
      .getSnapshot()
      .items.find(
        (each) =>
          each.kind === "update" &&
          !each.settled &&
          each.source.terminalId === found.terminalOf("mobile-app", 1)!.id,
      )
  const call = async (
    boot_: ReturnType<typeof boot>,
    project = "mobile-app",
    slot = 1,
    done: typeof report | null = report,
  ) => {
    const { turns, terminalOf } = boot_
    const terminal = terminalOf(project, slot)!
    const key = { projectId: project, workspaceSessionId: "initial", terminalId: terminal.id }
    turns.finish(key, terminal, "completed", done ? { done } : {})
    await vi.advanceTimersByTimeAsync(2000)
    return key
  }

  it("reports its finish in the Inbox as an update from its terminal", async () => {
    const found = boot()
    await vi.advanceTimersByTimeAsync(10_000)
    const key = await call(found)

    expect(updateOn(found)).toMatchObject({
      kind: "update",
      stopped: false,
      seen: false,
      source: { terminalId: key.terminalId },
      update: { type: "done", ...report },
    })
  })

  it("makes no Inbox entry when it finishes without calling done", async () => {
    const found = boot()
    await vi.advanceTimersByTimeAsync(10_000)
    await call(found, "mobile-app", 1, null)
    await vi.advanceTimersByTimeAsync(finishGraceMs + 1)

    expect(updateOn(found)).toBeUndefined()
    expect(
      found.inbox.turns?.getSnapshot()?.some((entry) => entry.projectId === "mobile-app"),
    ).toBe(true)
  })

  it("is read by the person, and goes", async () => {
    const found = boot()
    await vi.advanceTimersByTimeAsync(10_000)
    await call(found)
    const entry = updateOn(found)!

    found.inbox.answer(entry.id, { kind: "update", action: "read" })
    expect(rowWith(found.inbox, entry.id)).toBeUndefined()
    // It stays, resolved, as history.
    expect(
      found.inbox.state.getSnapshot().items.find(({ id }) => id === entry.id)?.settled,
    ).toMatchObject({
      how: "read",
    })
  })

  it("is the person's for a worker too, while its lead's agent runs", async () => {
    const found = boot()
    await vi.advanceTimersByTimeAsync(10_000)
    const worker = found.terminalOf("mobile-app", 1)!
    // Slot 2 runs an agent too, for a moment of work, and leads the first.
    const idle = found.terminalOf("mobile-app", 2)!
    found.turns.work(
      { projectId: "mobile-app", workspaceSessionId: "initial", terminalId: idle.id },
      idle,
    )
    await vi.advanceTimersByTimeAsync(0)
    const lead = found.terminalOf("mobile-app", 2)!
    found.store.transact([
      {
        type: "terminal/update",
        target: { projectId: "mobile-app", workspaceSessionId: "initial" },
        terminalId: worker.id,
        ledBy: lead.handle,
      },
    ] as never)
    expect(found.terminalOf("mobile-app", 1)).toMatchObject({ ledBy: lead.handle })
    await call(found)

    expect(updateOn(found)).toMatchObject({ update: { type: "done", ...report } })
  })
})

describe("The demo Inbox's order", () => {
  it("keeps the entries still listed, by key, and forgets the rest", () => {
    const inbox = createDemoInbox(Date.now())
    const [first, second] = inbox.state.getSnapshot().items
    const key = (entry: typeof first) => `${entry!.id}@${entry!.at}`
    inbox.arrange?.([key(second), "gone@1", key(first)])
    expect(inbox.order?.getSnapshot()).toEqual([key(second), key(first)])
  })
})
