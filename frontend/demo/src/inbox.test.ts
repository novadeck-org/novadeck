import {
  inboxType,
  ordered,
  type InboxAnswer,
  type InboxFinish,
  type InboxItem,
  type InboxUnread,
} from "@novadeck/core/inbox"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { createStore, createWorkspaceStore } from "@novadeck/core/store"
import type { TerminalMetadata } from "@novadeck/core/types"
import { afterEach, beforeEach, vi } from "vitest"

import { answerMs as chatAnswerMs, answeredMs } from "./chat"
import { answerMs, createDemoInbox, isDemoInbox } from "./inbox"
import { demoInboxIds, demoInboxItems, demoInboxItemsAll } from "./inbox-fixtures"
import { plainDemo, type PlainVariant } from "./index"
import { chatAgent, demoTerminalId } from "./samples"
import { context, describe, expect, it } from "./test"
import { createDemo, demoVariants } from "./variants"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const now = 1_000_000_000_000

const ids = (inbox: ReturnType<typeof createDemoInbox>): string[] =>
  inbox.state.getSnapshot().items.map((each) => each.id)

describe("the demo Inbox's items", () => {
  it("covers every type, each kind and every ask shape", () => {
    // The list starts with most of them; the debug panel adds the rest.
    const items = demoInboxItemsAll(now)
    expect(new Set(items.map(inboxType))).toEqual(
      new Set(["approve", "ask", "trouble", "update", "feedback"]),
    )
    expect(new Set(items.map((each) => each.kind))).toEqual(
      new Set(["request", "held", "ask", "trouble", "update", "feedback"]),
    )
    const shapes = items.flatMap((each) => (each.kind === "ask" ? [each.ask.shape.type] : []))
    expect(new Set(shapes)).toEqual(new Set(["options", "action", "text"]))
    const troubles = items.flatMap((each) => (each.kind === "trouble" ? [each.trouble.type] : []))
    expect(new Set(troubles)).toEqual(new Set(["stuck", "limit", "failed", "waits"]))
    const requests = items.flatMap((each) => (each.kind === "request" ? [each.request.kind] : []))
    expect(new Set(requests)).toEqual(new Set(["permission", "question", "plan"]))
    const updates = items.flatMap((each) => (each.kind === "update" ? [each.update.type] : []))
    expect(new Set(updates)).toEqual(new Set(["finished", "told"]))
  })

  it("puts one item on each sample terminal, none seen, none from the future", () => {
    // The states the debug panel adds too: each on a terminal of its own, but for a held
    // message, which is its thread's, and messages held long, which are the terminal's
    // alongside whatever else it shows.
    const items = demoInboxItemsAll(now).filter(
      (each) => each.kind !== "held" && !(each.kind === "trouble" && each.trouble.type === "waits"),
    )
    const terminals = items.map((each) => each.source.terminalId)
    expect(new Set(terminals).size).toBe(terminals.length)
    expect(items.every((each) => !each.seen && each.at <= now)).toBe(true)
  })

  it("gives the Codex permission Codex's own options", () => {
    const codex = demoInboxItems(now).find((each) => each.id === demoInboxIds.codexPermission)
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
    it("keeps the item and says why, then answers normally", () => {
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
    it("marks the item answering, then removes it", () => {
      const inbox = createDemoInbox(now)
      inbox.answer(demoInboxIds.held, { kind: "held", action: "release" })
      expect(inbox.state.getSnapshot().answering).toEqual({ [demoInboxIds.held]: true })
      expect(ids(inbox)).toContain(demoInboxIds.held)
      vi.advanceTimersByTime(answerMs)
      expect(inbox.state.getSnapshot().answering).toEqual({})
      expect(ids(inbox)).not.toContain(demoInboxIds.held)
    })

    it("ignores an item that is not there", () => {
      const inbox = createDemoInbox(now)
      const before = inbox.state.getSnapshot()
      inbox.answer("nothing", { kind: "held", action: "stop" })
      expect(inbox.state.getSnapshot()).toBe(before)
    })

    it("fails an answer meant for another kind of item, leaving the item", () => {
      const inbox = createDemoInbox(now)
      inbox.answer(demoInboxIds.held, { kind: "update", action: "read" })
      vi.advanceTimersByTime(answerMs)
      expect(ids(inbox)).toContain(demoInboxIds.held)
      expect(Object.keys(inbox.state.getSnapshot().failed)).toEqual([demoInboxIds.held])
    })
  })

  context("when auto-resume is turned off at a limit", () => {
    it("keeps the item, now waiting on the person", () => {
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

  context("when an item is seen", () => {
    it("marks only that item", () => {
      const inbox = createDemoInbox(now)
      inbox.see(demoInboxIds.stuck)
      const seen = inbox.state.getSnapshot().items.filter((each) => each.seen)
      expect(seen.map((each) => each.id)).toEqual([demoInboxIds.stuck])
    })
  })

  context("when every update is read", () => {
    it("removes the updates and nothing that waits", () => {
      const inbox = createDemoInbox(now)
      const waiting = demoInboxItems(now).filter((each) => each.kind !== "update")
      inbox.readAll()
      expect(ids(inbox)).toEqual(ordered(waiting).map((each) => each.id))
    })
  })

  context("when a feedback draft is answered", () => {
    const sent = { kind: "feedback", answer: { type: "send", text: "edited" } } as const
    const discarded = { kind: "feedback", answer: { type: "discard" } } as const

    it("removes it after the answer delay on Send, recording what was sent", () => {
      const record = vi.fn<Parameters<typeof createDemoInbox>[2] & {}>()
      const inbox = createDemoInbox(now, [], record)
      const draft = demoInboxItemsAll(now).find((each) => each.id === demoInboxIds.feedback)
      inbox.add(draft!)
      record.mockClear()
      inbox.answer(demoInboxIds.feedback, sent)
      expect(inbox.state.getSnapshot().answering).toEqual({ [demoInboxIds.feedback]: true })
      expect(ids(inbox)).toContain(demoInboxIds.feedback)
      vi.advanceTimersByTime(answerMs)
      expect(ids(inbox)).toEqual([])
      expect(record).toHaveBeenCalledWith(draft, sent, undefined)
    })

    it("removes it the same way on Discard", () => {
      const inbox = createDemoInbox(now, [])
      inbox.add(demoInboxItemsAll(now).find((each) => each.id === demoInboxIds.feedback)!)
      inbox.answer(demoInboxIds.feedback, discarded)
      vi.advanceTimersByTime(answerMs)
      expect(ids(inbox)).toEqual([])
    })

    it("keeps it, saying why, when the answer is made to fail, and refuses another kind's", () => {
      const inbox = createDemoInbox(now, [])
      inbox.add(demoInboxItemsAll(now).find((each) => each.id === demoInboxIds.feedback)!)
      inbox.failNext()
      inbox.answer(demoInboxIds.feedback, sent)
      expect(inbox.state.getSnapshot().failed[demoInboxIds.feedback]).toMatch(/Try again/)
      inbox.answer(demoInboxIds.feedback, { kind: "update", action: "read" })
      expect(inbox.state.getSnapshot().failed[demoInboxIds.feedback]).toMatch(/isn't for this/)
      vi.advanceTimersByTime(answerMs)
      expect(ids(inbox)).toContain(demoInboxIds.feedback)
    })

    it("stays when every update is read", () => {
      const inbox = createDemoInbox(now, [])
      inbox.add(demoInboxItemsAll(now).find((each) => each.id === demoInboxIds.feedback)!)
      inbox.readAll()
      expect(ids(inbox)).toEqual([demoInboxIds.feedback])
    })
  })

  context("when an item arrives", () => {
    it("joins the Inbox, replacing one with its ID, until it is cleared", () => {
      const inbox = createDemoInbox(now, [])
      const [first] = demoInboxItems(now) as [InboxItem]
      inbox.add(first)
      inbox.add({ ...first, at: now + 1 })
      expect(inbox.state.getSnapshot().items).toEqual([{ ...first, at: now + 1 }])
      inbox.clear()
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
  const backend = plainDemo(variant)
  const store = createWorkspaceStore(
    workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 0 }),
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  backend.start!({ dispatch: (actions) => store.transact(actions as never), open: () => {} })
  const unread = createStore<InboxUnread>({})
  const read = vi.fn<(finishes: readonly InboxFinish[]) => void>()
  const { inbox } = backend
  if (!isDemoInbox(inbox)) throw new Error("every demo has the demo's Inbox")
  const unbind = inbox.bind!({ workspace: store, unread, read })
  const terminalOf = (projectId: string, slot: number): TerminalMetadata | undefined =>
    store
      .getSnapshot()
      .projects.find((project) => project.id === projectId)
      ?.history[0]?.state.roster.terminals.find(
        (terminal) =>
          terminal.id === demoTerminalId({ projectId, workspaceSessionId: "initial" }, slot),
      )
  const itemOn = (projectId: string, slot: number): InboxItem | undefined =>
    inbox.state
      .getSnapshot()
      .items.find((item) => item.source.terminalId === terminalOf(projectId, slot)?.id)
  return { backend, inbox, store, unread, read, unbind, terminalOf, itemOn }
}

const waitsOn = (terminal: TerminalMetadata | undefined) =>
  terminal?.state === "running" ? terminal.agent?.attention?.kind : undefined

// The first option of a request's dialog, as the person would pick it.
const firstChoice = (item: InboxItem | undefined): InboxAnswer => {
  if (item?.kind !== "request" || item.request.dialog?.type !== "choices")
    throw new Error("not a dialog of choices")
  const { dialog } = item.request
  return {
    kind: "request",
    answer: { type: "choice", dialog: dialog.id, option: dialog.options[0]!.id },
  }
}

describe("the agents demo's Inbox", () => {
  it("shows the draft an Ask made over its agent's unseen finish and a held thread", async () => {
    const { backend, inbox, unread, itemOn, store } = boot()
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
    await backend.feedback!.ask(key, "")
    await vi.advanceTimersByTimeAsync(3 * 1500 + 100)
    // The writing turn ended unseen: the agent finished while the person looked elsewhere.
    unread.update(() => ({ [`${found.project}/initial`]: { [found.terminal.id]: "done" } }))
    const held = demoInboxItemsAll(now).find((each) => each.id === demoInboxIds.held)!
    inbox.add({
      ...held,
      id: "held-here",
      source: { ...held.source, terminalId: found.terminal.id },
    })
    const kinds = inbox.state
      .getSnapshot()
      .items.filter((each) => each.source.terminalId === found.terminal.id)
      .map((each) => each.kind)
    expect(kinds).toContain("feedback")
    expect(itemOn(found.project, Number(found.terminal.id.slice(-2)))).toBeDefined()
  })

  it("shows a feedback draft beside what its terminal waits on, as its own row", () => {
    const { inbox, itemOn, terminalOf } = boot()
    const draft = demoInboxItemsAll(now).find((each) => each.id === demoInboxIds.feedback)!
    const draftFor = (id: string, terminalId: string): InboxItem => ({
      ...draft,
      id,
      source: { ...draft.source, terminalId, projectId: "storefront" },
    })
    // Terminal 4 of storefront asks for a permission: the request and the draft both show.
    const asking = terminalOf("storefront", 4)!.id
    inbox.add(draftFor("draft-asking", asking))
    expect(itemOn("storefront", 4)?.kind).toBe("request")
    expect(ids(inbox)).toContain("draft-asking")
    // One that waits on nothing shows its draft too.
    const quiet = terminalOf("storefront", 6)!.id
    inbox.add(draftFor("draft-quiet", quiet))
    expect(ids(inbox)).toContain("draft-quiet")
  })

  it("lists what each of its agents waits on, as their terminals say", () => {
    const { itemOn, inbox } = boot()
    for (const [project, slot, kind] of [
      ["storefront", 1, "plan"],
      ["storefront", 4, "permission"],
      ["api-service", 1, "plan"],
      ["api-service", 4, "permission"],
      ["docs-site", 1, "question"],
    ] as const) {
      const item = itemOn(project, slot)
      expect(item?.kind === "request" && item.request.kind, `${project} ${slot}`).toBe(kind)
    }
    expect(inbox.state.getSnapshot().items.every((item) => item.kind === "request")).toBe(true)
  })

  context("when a request is answered", () => {
    it("moves its agent on, as an answer on its screen does, and the item goes", async () => {
      const { inbox, itemOn, terminalOf } = boot()
      const codex = itemOn("storefront", 4)
      expect(waitsOn(terminalOf("storefront", 4))).toBe("permission")

      inbox.answer(codex!.id, firstChoice(codex))
      expect(inbox.state.getSnapshot().answering[codex!.id]).toBe(true)
      await vi.advanceTimersByTimeAsync(chatAnswerMs + answeredMs)

      expect(waitsOn(terminalOf("storefront", 4))).toBeUndefined()
      expect(itemOn("storefront", 4)).toBeUndefined()
    })

    it("says why where the answer didn't take, and keeps the item", async () => {
      const { inbox, itemOn } = boot()
      const codex = itemOn("storefront", 4)!
      inbox.failNext()
      inbox.answer(codex.id, firstChoice(codex))
      await vi.advanceTimersByTimeAsync(0)
      expect(inbox.state.getSnapshot().failed[codex.id]).toMatch(/Try again/)
      expect(itemOn("storefront", 4)?.id).toBe(codex.id)
    })
  })

  context("when an agent finished while the person looked elsewhere", () => {
    it("lists its reply, and reads it through the app", async () => {
      const { inbox, unread, read, itemOn, terminalOf } = boot()
      await vi.advanceTimersByTimeAsync(10_000)
      const done = terminalOf("design-system", 1)!
      unread.update(() => ({ "design-system/initial": { [done.id]: "done" } }))
      const item = itemOn("design-system", 1)
      expect(item).toMatchObject({ kind: "update", update: { type: "finished" } })

      inbox.answer(item!.id, { kind: "update", action: "read" })
      expect(read).toHaveBeenCalledExactlyOnceWith([
        { context: "design-system/initial", terminalId: done.id },
      ])
    })
  })

  context("when trouble is answered and its item stays", () => {
    it("holds its buttons a moment, then gives them back", async () => {
      const { inbox, unread, itemOn, terminalOf } = boot()
      await vi.advanceTimersByTimeAsync(10_000)
      const infra = terminalOf("infra", 1)!
      unread.update(() => ({ "infra/initial": { [infra.id]: "failed" } }))
      const trouble = itemOn("infra", 1)!
      expect(trouble).toMatchObject({ kind: "trouble", trouble: { type: "failed" } })

      inbox.answer(trouble.id, { kind: "trouble", action: { type: "stop" } })
      await vi.advanceTimersByTimeAsync(0)
      expect(itemOn("infra", 1)?.id).toBe(trouble.id)
      expect(inbox.state.getSnapshot().answering[trouble.id]).toBe(true)
      await vi.advanceTimersByTimeAsync(3000)
      expect(inbox.state.getSnapshot().answering[trouble.id]).toBeUndefined()
    })
  })

  context("when an item is seen", () => {
    it("marks only that item", () => {
      const { inbox, itemOn } = boot()
      const codex = itemOn("storefront", 4)!
      inbox.see(codex.id)
      const seen = inbox.state.getSnapshot().items.filter((each) => each.seen)
      expect(seen.map((each) => each.id)).toEqual([codex.id])
    })
  })

  context("when the app unbinds it", () => {
    it("empties of what the agents wait on", () => {
      const { inbox, unbind } = boot()
      unbind()
      expect(inbox.state.getSnapshot().items).toEqual([])
    })

    it("forgets what it knew of their items, once bound again", async () => {
      const { inbox, itemOn, unbind, store, unread, read } = boot()
      const codex = itemOn("storefront", 4)!
      inbox.see(codex.id)
      inbox.failNext()
      inbox.answer(codex.id, firstChoice(codex))
      await vi.advanceTimersByTimeAsync(0)
      unbind()

      inbox.bind!({ workspace: store, unread, read })
      const again = itemOn("storefront", 4)
      expect(again).toMatchObject({ id: codex.id, seen: false })
      expect(inbox.state.getSnapshot().failed).toEqual({})
    })
  })

  context("when the workspace changes in a way no item shows", () => {
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

  it("names each request by its terminal, so the same sample in two sessions is two items", () => {
    const { itemOn, terminalOf } = boot()
    const codex = itemOn("storefront", 4)
    expect(codex?.id).toContain(terminalOf("storefront", 4)!.id)
  })
})

describe("the Inbox demo's own items", () => {
  it("take the place of a dialog their terminal's agent shows, and only that", () => {
    const { inbox, terminalOf } = boot("inbox")
    const items = inbox.state.getSnapshot().items
    const on = (terminalId: string) => items.filter((each) => each.source.terminalId === terminalId)
    const codex = terminalOf("storefront", 4)!.id
    expect(
      on(codex)
        .filter((each) => each.kind === "request")
        .map((each) => each.id),
    ).toEqual([demoInboxIds.codexPermission])
    const standing = new Set(
      items
        .filter((each) => !each.id.startsWith("request:") && each.kind !== "held")
        .filter((each) => each.kind !== "update")
        .map((each) => each.source.terminalId),
    )
    for (const terminalId of standing)
      expect(on(terminalId).filter((each) => each.id.startsWith("request:"))).toEqual([])
  })

  it("read a finish beside an ask of their own, when every update is read", async () => {
    const { inbox, unread, read, terminalOf, itemOn } = boot("inbox")
    await vi.advanceTimersByTimeAsync(10_000)
    const done = terminalOf("design-system", 1)!
    unread.update(() => ({ "design-system/initial": { [done.id]: "done" } }))
    const finish = itemOn("design-system", 1)!
    expect(finish.kind).toBe("update")
    const ask = inbox.state.getSnapshot().items.find((each) => each.id === demoInboxIds.webhook)!
    inbox.add({ ...ask, source: { ...finish.source } })
    expect(inbox.state.getSnapshot().items.map((each) => each.id)).toContain(finish.id)

    inbox.readAll()
    expect(read).toHaveBeenCalledExactlyOnceWith([
      { context: "design-system/initial", terminalId: done.id },
    ])
  })

  it("read a finish under an update of their own, which is read with it", async () => {
    const { inbox, unread, read, terminalOf, itemOn } = boot("inbox")
    await vi.advanceTimersByTimeAsync(10_000)
    const done = terminalOf("design-system", 1)!
    unread.update(() => ({ "design-system/initial": { [done.id]: "done" } }))
    const finish = itemOn("design-system", 1)!
    const told = inbox.state.getSnapshot().items.find((each) => each.id === demoInboxIds.told)!
    inbox.add({ ...told, source: { ...finish.source } })
    expect(itemOn("design-system", 1)?.id).toBe(demoInboxIds.told)

    inbox.readAll()
    expect(read).toHaveBeenCalledExactlyOnceWith([
      { context: "design-system/initial", terminalId: done.id },
    ])
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
