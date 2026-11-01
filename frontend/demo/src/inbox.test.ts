import { finishGraceMs } from "@novadeck/core/agents/finish"
import {
  inboxType,
  ordered,
  type InboxAnswer,
  type InboxRow,
  type InboxTurn,
} from "@novadeck/core/inbox"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore } from "@novadeck/core/store"
import type { AgentTurnEnd, TerminalMetadata } from "@novadeck/core/types"
import { afterEach, beforeEach, vi } from "vitest"

import { answerMs as chatAnswerMs, answeredMs } from "./agents/chat"
import { demoTurns } from "./agents/turns"
import { answerMs, createDemoInbox, isDemoInbox } from "./inbox"
import {
  demoEndingGrant,
  demoInboxIds,
  demoInboxRows,
  demoInboxRowsAll,
  demoLiveGrant,
} from "./inbox/fixtures"
import { plainDemo, type PlainVariant } from "./index"
import { chatAgent, demoTerminalId } from "./samples"
import { context, describe, expect, it } from "./test"
import { createDemo, demoVariants } from "./variants"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const now = 1_000_000_000_000

const ids = (inbox: ReturnType<typeof createDemoInbox>): string[] =>
  inbox.state.getSnapshot().items.map((each) => each.id)

describe("the demo Inbox's rows", () => {
  it("covers every type, each kind and every ask shape", () => {
    // The list starts with most of them; the debug panel adds the rest.
    const rows = demoInboxRowsAll(now)
    expect(new Set(rows.map(inboxType))).toEqual(new Set(["unblock", "ask", "trouble", "update"]))
    expect(new Set(rows.map((each) => each.kind))).toEqual(
      new Set(["request", "held", "ask", "grant", "trouble", "update"]),
    )
    const shapes = rows.flatMap((each) => (each.kind === "ask" ? [each.ask.shape.type] : []))
    expect(new Set(shapes)).toEqual(new Set(["options", "action", "text", "approval"]))
    const troubles = rows.flatMap((each) => (each.kind === "trouble" ? [each.trouble.type] : []))
    expect(new Set(troubles)).toEqual(new Set(["stuck", "limit", "failed", "waits"]))
    const requests = rows.flatMap((each) => (each.kind === "request" ? [each.request.kind] : []))
    expect(new Set(requests)).toEqual(new Set(["permission", "question", "plan"]))
    const updates = rows.flatMap((each) => (each.kind === "update" ? [each.update.type] : []))
    expect(new Set(updates)).toEqual(new Set(["done", "told"]))
  })

  it("presents an ask whose answer is an action as an unblock, and a question as an ask", () => {
    const rows = demoInboxRowsAll(now)
    const typeOf = (id: string) => inboxType(rows.find((each) => each.id === id)!)
    expect(typeOf(demoInboxIds.login)).toBe("unblock")
    expect(typeOf(demoInboxIds.grant)).toBe("unblock")
    expect(typeOf(demoInboxIds.approval)).toBe("unblock")
    expect(typeOf(demoInboxIds.question)).toBe("ask")
    expect(typeOf(demoInboxIds.done)).toBe("update")
  })

  it("puts one row on each sample terminal, none seen, none from the future", () => {
    // The states the debug panel adds too: each on a terminal of its own, but for a held
    // message, which is its thread's, and messages held long, which are the terminal's
    // alongside whatever else it shows.
    const rows = demoInboxRowsAll(now).filter(
      (each) => each.kind !== "held" && !(each.kind === "trouble" && each.trouble.type === "waits"),
    )
    const terminals = rows.map((each) => each.source.terminalId)
    expect(new Set(terminals).size).toBe(terminals.length)
    expect(rows.every((each) => !each.seen && each.at <= now)).toBe(true)
  })

  it("gives the Codex permission Codex's own options", () => {
    const codex = demoInboxRows(now).find((each) => each.id === demoInboxIds.codexPermission)
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
    it("keeps the row and says why, then answers normally", () => {
      const inbox = createDemoInbox(now)
      inbox.failNext()
      inbox.answer(demoInboxIds.held, { kind: "held", action: "release" })
      vi.advanceTimersByTime(answerMs)
      expect(ids(inbox)).toContain(demoInboxIds.held)
      expect(inbox.state.getSnapshot().failed[demoInboxIds.held]).toMatch(/Try again/)

      inbox.answer(demoInboxIds.held, { kind: "held", action: "release" })
      vi.advanceTimersByTime(answerMs)
      expect(ids(inbox)).not.toContain(demoInboxIds.held)
    })
  })

  context("when an answer is sent", () => {
    it("marks the row answering, then removes it", () => {
      const inbox = createDemoInbox(now)
      inbox.answer(demoInboxIds.held, { kind: "held", action: "release" })
      expect(inbox.state.getSnapshot().answering).toEqual({ [demoInboxIds.held]: true })
      expect(ids(inbox)).toContain(demoInboxIds.held)
      vi.advanceTimersByTime(answerMs)
      expect(inbox.state.getSnapshot().answering).toEqual({})
      expect(ids(inbox)).not.toContain(demoInboxIds.held)
    })

    it("ignores a row that is not there", () => {
      const inbox = createDemoInbox(now)
      const before = inbox.state.getSnapshot()
      inbox.answer("nothing", { kind: "held", action: "stop" })
      expect(inbox.state.getSnapshot()).toBe(before)
    })

    it("fails an answer meant for another kind of row, leaving the row", () => {
      const inbox = createDemoInbox(now)
      inbox.answer(demoInboxIds.held, { kind: "update", action: "read" })
      vi.advanceTimersByTime(answerMs)
      expect(ids(inbox)).toContain(demoInboxIds.held)
      expect(Object.keys(inbox.state.getSnapshot().failed)).toEqual([demoInboxIds.held])
    })
  })

  context("when auto-resume is turned off at a limit", () => {
    it("keeps the row, now waiting on the person", () => {
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

  context("when a row is seen", () => {
    it("marks only that row", () => {
      const inbox = createDemoInbox(now)
      inbox.see(demoInboxIds.stuck)
      const seen = inbox.state.getSnapshot().items.filter((each) => each.seen)
      expect(seen.map((each) => each.id)).toEqual([demoInboxIds.stuck])
    })
  })

  context("when every update is read", () => {
    it("removes the updates and nothing that waits", () => {
      const inbox = createDemoInbox(now)
      const waiting = demoInboxRows(now).filter((each) => each.kind !== "update")
      inbox.readAll()
      expect(ids(inbox)).toEqual(ordered(waiting).map((each) => each.id))
    })
  })

  context("when a row arrives", () => {
    it("joins the Inbox, replacing one with its ID, until it is cleared", () => {
      const inbox = createDemoInbox(now, [])
      const [first] = demoInboxRows(now) as [InboxRow]
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
  const rowOn = (projectId: string, slot: number): InboxRow | undefined =>
    inbox.state
      .getSnapshot()
      .items.find((row) => row.source.terminalId === terminalOf(projectId, slot)?.id)
  // An agent's turn ends as the terminal's status says, a completed one standing past the
  // grace that tells it a finish.
  let ends = 0
  const finish = async (
    projectId: string,
    slot: number,
    outcome: "completed" | "failed" = "completed",
    more: Partial<AgentTurnEnd> = {},
  ): Promise<readonly InboxTurn[]> => {
    const before = new Set(inbox.turns?.getSnapshot()?.map((row) => row.id))
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
    return (inbox.turns?.getSnapshot() ?? []).filter((row) => !before.has(row.id))
  }
  return { backend, inbox, store, unbind, terminalOf, rowOn, finish, turns }
}

// The row of this id the Inbox shows.
const rowWith = (inbox: ReturnType<typeof createDemoInbox>, id: string): InboxRow | undefined =>
  inbox.state.getSnapshot().items.find((each) => each.id === id)

const waitsOn = (terminal: TerminalMetadata | undefined) =>
  terminal?.state === "running" ? terminal.agent?.attention?.kind : undefined

// The first option of a request's dialog, as the person would pick it.
const firstChoice = (row: InboxRow | undefined): InboxAnswer => {
  if (row?.kind !== "request" || row.request.dialog?.type !== "choices")
    throw new Error("not a dialog of choices")
  const { dialog } = row.request
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
    const question = demoInboxRowsAll(now).find((each) => each.kind === "ask")!
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
    const question = demoInboxRowsAll(now).find((each) => each.kind === "ask")!
    // The agent works, and a Continue waits behind its turn; the person takes the line back.
    expect(turns.prompt("Get on with it.", found.terminal, key)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await backend.conversations!.send(key, "continue", { automatic: true })
    expect(await backend.conversations!.interrupt(key)).toBe("continue")
    inbox.add({ ...question, id: "ask-here", source: { ...question.source, ...key } })
    // Sent again as their own words, the line still matches the mark, which waited.
    await vi.advanceTimersByTimeAsync(5_000)
    await backend.conversations!.send(key, "continue")
    await vi.advanceTimersByTimeAsync(1)
    expect(ids(inbox)).toContain("ask-here")
  })

  it("settles an agent's open asks as replied when the person writes to it, and no other row", async () => {
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
          !terminal.agent?.working &&
          !terminal.agent?.attention &&
          !inbox.state.getSnapshot().items.some((each) => each.source.terminalId === terminal.id),
      )!
    const key = {
      projectId: found.project,
      workspaceSessionId: "initial",
      terminalId: found.terminal.id,
    }
    const all = demoInboxRowsAll(now)
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
    await vi.advanceTimersByTimeAsync(1)
    expect(ids(inbox)).toContain("ask-later")
    const left = ids(inbox)
    // It stays, settled; an ask on another terminal, and an update on this one, are as they were.
    const row = (id: string) => inbox.state.getSnapshot().items.find((each) => each.id === id)!
    expect(row("ask-here").settled).toMatchObject({ how: "replied" })
    expect(row("ask-elsewhere").settled).toBeUndefined()
    expect(row("update-here").settled).toBeUndefined()
    expect(left).toEqual(expect.arrayContaining(["update-here", "ask-elsewhere"]))
  })

  it("dismisses an open ask in place, lists it last, and clears only settled asks", async () => {
    const { inbox } = boot()
    const all = demoInboxRowsAll(now)
    const question = all.find((each) => each.kind === "ask")!
    inbox.add({ ...question, id: "ask-a" })
    inbox.add({ ...question, id: "ask-b" })
    const row = (id: string) => inbox.state.getSnapshot().items.find((each) => each.id === id)
    inbox.dismiss!("ask-a")
    expect(row("ask-a")?.settled).toMatchObject({ how: "dismissed" })
    expect(row("ask-a")?.stopped).toBe(false)
    expect(ids(inbox).at(-1)).toBe("ask-a")
    // A withdrawn ask, and one whose agent's session ended.
    inbox.resolve("ask-b", "withdrawn")
    expect(row("ask-b")?.settled).toMatchObject({ how: "withdrawn" })
    // Clearing leaves what is open, and a settled ask goes.
    const open = inbox.state.getSnapshot().items.filter((each) => !each.settled).length
    inbox.clear!(["ask-a", ...ids(inbox).filter((id) => !row(id)?.settled)])
    expect(row("ask-a")).toBeUndefined()
    expect(row("ask-b")).toBeDefined()
    expect(inbox.state.getSnapshot().items.filter((each) => !each.settled)).toHaveLength(open)
    inbox.add({ ...question, id: "ask-c" })
    inbox.resolve("ask-c", "gone")
    expect(row("ask-c")).toBeUndefined()
    // A settled ask cannot be answered or dismissed again.
    inbox.answer("ask-b", { kind: "ask", answer: { type: "reply", option: null, text: "x" } })
    inbox.dismiss!("ask-b")
    expect(row("ask-b")?.settled).toMatchObject({ how: "withdrawn" })
  })

  it("leaves an ask open, with no answer error, when its dismissal fails", () => {
    const { inbox } = boot()
    const question = demoInboxRowsAll(now).find((each) => each.kind === "ask")!
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

  it("makes no row of the draft an Ask made, nor of the agent's finish, beside a held thread", async () => {
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
    // the demo stored its finish as a row, which is no Inbox row.
    await finish(found.project, Number(found.terminal.id.slice(-2)))
    const held = demoInboxRowsAll(now).find((each) => each.id === demoInboxIds.held)!
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
      const row = rowOn(project, slot)
      expect(row?.kind === "request" && row.request.kind, `${project} ${slot}`).toBe(kind)
    }
    expect(inbox.state.getSnapshot().items.every((row) => row.kind === "request")).toBe(true)
  })

  context("when a request is answered", () => {
    it("moves its agent on, as an answer on its screen does, and the row goes", async () => {
      const { inbox, rowOn, terminalOf } = boot()
      const codex = rowOn("storefront", 4)
      expect(waitsOn(terminalOf("storefront", 4))).toBe("permission")

      inbox.answer(codex!.id, firstChoice(codex))
      expect(inbox.state.getSnapshot().answering[codex!.id]).toBe(true)
      await vi.advanceTimersByTimeAsync(chatAnswerMs + answeredMs)

      expect(waitsOn(terminalOf("storefront", 4))).toBeUndefined()
      expect(rowOn("storefront", 4)).toBeUndefined()
    })

    it("says why where the answer didn't take, and keeps the row", async () => {
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
    it("stores its reply as a finished turn that marks its tab, and lists no row", async () => {
      const { inbox, finish } = boot()
      await vi.advanceTimersByTimeAsync(10_000)
      const [row] = await finish("design-system", 1)
      expect(row).toMatchObject({ projectId: "design-system", outcome: "completed" })
      expect(rowWith(inbox, row!.id)).toBeUndefined()

      inbox.readFinishes?.([{ context: "design-system/initial", terminalId: row!.terminalId }])
      expect(inbox.turns?.getSnapshot()?.some((each) => each.id === row!.id)).toBe(false)
    })

    it("records no row for an end that hit a usage limit", async () => {
      const { finish } = boot()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(await finish("design-system", 1, "failed", { limited: true })).toEqual([])
      expect(
        await finish("design-system", 1, "failed", { limit: { minutes: 60, resetsAt: 9e12 } }),
      ).toEqual([])
    })

    it("lists every end as its own row, and records one only after the grace", async () => {
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

    it("drops a terminal's rows when the person reads its finishes", async () => {
      const { inbox, finish, terminalOf } = boot()
      await vi.advanceTimersByTimeAsync(10_000)
      const [kept] = await finish("infra", 1)
      const [read] = await finish("design-system", 1)
      inbox.readFinishes?.([
        { context: "design-system/initial", terminalId: terminalOf("design-system", 1)!.id },
      ])
      const left = inbox.turns?.getSnapshot()?.map((row) => row.id)
      expect(left).toContain(kept!.id)
      expect(left).not.toContain(read!.id)
    })

    it("drops the rows of a terminal that closed", async () => {
      const { inbox, finish, store, terminalOf } = boot()
      await vi.advanceTimersByTimeAsync(10_000)
      const [row] = await finish("design-system", 1)
      const closing = terminalOf("design-system", 1)!
      store.transact([
        {
          type: "terminal/close",
          target: { projectId: "design-system", workspaceSessionId: "initial" },
          terminalId: closing.id,
        },
      ] as never)
      expect(terminalOf("design-system", 1)).toBeUndefined()
      expect(inbox.turns?.getSnapshot()?.some((each) => each.id === row!.id)).toBe(false)
    })
  })

  context("when trouble is answered and its row stays", () => {
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

  context("when a row is seen", () => {
    it("marks only that row", () => {
      const { inbox, rowOn } = boot()
      const codex = rowOn("storefront", 4)!
      inbox.see(codex.id)
      const seen = inbox.state.getSnapshot().items.filter((each) => each.seen)
      expect(seen.map((each) => each.id)).toEqual([codex.id])
    })
  })

  context("when the app unbinds it", () => {
    it("empties of what the agents wait on, and of the rows it stored", async () => {
      const { inbox, unbind, finish } = boot()
      await vi.advanceTimersByTimeAsync(10_000)
      await finish("design-system", 1)
      unbind()
      expect(inbox.state.getSnapshot().items).toEqual([])
      expect(inbox.turns?.getSnapshot()).toBeUndefined()
    })

    it("forgets what it knew of their rows, once bound again", async () => {
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

  context("when the workspace changes in a way no row shows", () => {
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

  it("names each request by its terminal, so the same sample in two sessions is two rows", () => {
    const { rowOn, terminalOf } = boot()
    const codex = rowOn("storefront", 4)
    expect(codex?.id).toContain(terminalOf("storefront", 4)!.id)
  })
})

describe("the Inbox demo's own rows", () => {
  it("take the place of a dialog their terminal's agent shows, and only that", () => {
    const { inbox, terminalOf } = boot("inbox")
    const rows = inbox.state.getSnapshot().items
    const on = (terminalId: string) => rows.filter((each) => each.source.terminalId === terminalId)
    const codex = terminalOf("storefront", 4)!.id
    expect(
      on(codex)
        .filter((each) => each.kind === "request")
        .map((each) => each.id),
    ).toEqual([demoInboxIds.codexPermission])
    const standing = new Set(
      rows
        .filter((each) => !each.id.startsWith("request:") && each.kind !== "held")
        .filter((each) => each.kind !== "update")
        .map((each) => each.source.terminalId),
    )
    for (const terminalId of standing)
      expect(on(terminalId).filter((each) => each.id.startsWith("request:"))).toEqual([])
  })

  it("leave a completed turn's row alone when every update is read: it only marks its tab", async () => {
    const { inbox, finish } = boot("inbox")
    await vi.advanceTimersByTimeAsync(10_000)
    const [made] = await finish("design-system", 1)

    inbox.readAll()
    expect(inbox.turns?.getSnapshot()?.some((each) => each.id === made!.id)).toBe(true)
  })

  it("leave a failed turn that still stops its agent when every update is read", async () => {
    const { inbox, finish } = boot("inbox")
    await vi.advanceTimersByTimeAsync(10_000)
    const [made] = await finish("infra", 1, "failed")
    const trouble = rowWith(inbox, made!.id)!
    expect(trouble).toMatchObject({ id: made!.id, kind: "trouble", stopped: true })
    inbox.readAll()
    expect(inbox.turns?.getSnapshot()?.some((each) => each.id === made!.id)).toBe(true)
    expect(rowWith(inbox, trouble.id)).toBeDefined()
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
  const updateOn = (found: ReturnType<typeof boot>): InboxRow | undefined =>
    found.inbox.state
      .getSnapshot()
      .items.find(
        (each) =>
          each.kind === "update" &&
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

  it("makes no Inbox row when it finishes without calling done", async () => {
    const found = boot()
    await vi.advanceTimersByTimeAsync(10_000)
    await call(found, "mobile-app", 1, null)
    await vi.advanceTimersByTimeAsync(finishGraceMs + 1)

    expect(updateOn(found)).toBeUndefined()
    expect(found.inbox.turns?.getSnapshot()?.some((row) => row.projectId === "mobile-app")).toBe(
      true,
    )
  })

  it("is read by the person, and goes", async () => {
    const found = boot()
    await vi.advanceTimersByTimeAsync(10_000)
    await call(found)
    const row = updateOn(found)!

    found.inbox.answer(row.id, { kind: "update", action: "read" })
    expect(rowWith(found.inbox, row.id)).toBeUndefined()
  })

  it("is read with every update, leaving what waits on the person", async () => {
    const found = boot()
    await vi.advanceTimersByTimeAsync(10_000)
    await call(found)
    const waiting = found.inbox.state.getSnapshot().items.filter((each) => each.kind !== "update")

    found.inbox.readAll()
    expect(updateOn(found)).toBeUndefined()
    expect(found.inbox.state.getSnapshot().items).toEqual(waiting)
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
  it("keeps the rows still listed, by key, and forgets the rest", () => {
    const inbox = createDemoInbox(Date.now())
    const [first, second] = inbox.state.getSnapshot().items
    const key = (row: typeof first) => `${row!.id}@${row!.at}`
    inbox.arrange?.([key(second), "gone@1", key(first)])
    expect(inbox.order?.getSnapshot()).toEqual([key(second), key(first)])
  })
})

describe("the demo Inbox's grants", () => {
  const withCards = () => createDemoInbox(now, demoInboxRowsAll(now))

  it("starts with none live", () => {
    expect(withCards().grants.state.getSnapshot()).toEqual([])
  })

  it("makes a team grant from what the Grant card kept ticked, for the lifetime chosen", () => {
    const inbox = withCards()
    inbox.answer(demoInboxIds.grant, {
      kind: "grant",
      answer: {
        type: "grant",
        presets: ["push"],
        commands: [1],
        repos: ["github.com/acme/storefront-ui"],
        withLead: true,
        lifetime: "hour",
      },
    })
    vi.advanceTimersByTime(answerMs)

    expect(ids(inbox)).not.toContain(demoInboxIds.grant)
    const [grant] = inbox.grants.state.getSnapshot()
    expect(grant).toMatchObject({
      holder: { kind: "team", lead: "moth", withLead: true },
      presets: ["push"],
      commands: [{ argv: ["uberepo", "ship"], rest: true }],
      repos: [{ url: "github.com/acme/storefront-ui" }],
      entryId: demoInboxIds.grant,
    })
    expect(grant!.endsAt! - grant!.madeAt).toBe(3_600_000)
  })

  it("makes a grant for the asking terminal alone on Approve, until done or for the hour chosen", () => {
    const inbox = withCards()
    inbox.answer(demoInboxIds.approval, {
      kind: "ask",
      answer: { type: "approve", lifetime: "until-done" },
    })
    vi.advanceTimersByTime(answerMs)

    const [grant] = inbox.grants.state.getSnapshot()
    expect(grant).toMatchObject({
      holder: { kind: "terminal", handle: "moth" },
      presets: [],
      repos: [],
    })
    expect(grant!.commands).toHaveLength(3)
    expect(grant).toMatchObject({ lifetime: "until-done", endsAt: null })
  })

  it("makes none from a reply to an approval, nor from a dismissed Grant card, which settles", () => {
    const inbox = withCards()
    inbox.answer(demoInboxIds.approval, {
      kind: "ask",
      answer: { type: "reply", option: null, text: "No, thanks." },
    })
    inbox.dismiss!(demoInboxIds.grant)
    vi.advanceTimersByTime(answerMs)

    expect(inbox.grants.state.getSnapshot()).toEqual([])
    expect(
      inbox.state.getSnapshot().items.find((each) => each.id === demoInboxIds.grant)?.settled?.how,
    ).toBe("dismissed")
  })

  it("drops a grant when it is revoked, and when its time is up", () => {
    const inbox = withCards()
    const [live, ending] = [demoLiveGrant(Date.now()), demoEndingGrant(Date.now(), 1000)]
    inbox.grants.add(live)
    inbox.grants.add(ending)
    expect(inbox.grants.state.getSnapshot()).toHaveLength(2)
    inbox.grants.revoke(live.id)
    expect(inbox.grants.state.getSnapshot().map(({ id }) => id)).toEqual([ending.id])
    vi.advanceTimersByTime(999)
    expect(inbox.grants.state.getSnapshot()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(inbox.grants.state.getSnapshot()).toEqual([])
  })
})
