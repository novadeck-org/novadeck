import type { CompanionItem, CompanionWindow, TerminalSummary } from "@novadeck/protocol"
import { RunnerError } from "@novadeck/protocol/client"
import { vi } from "vitest"

import { itemIdOf } from "../../model/companion"
import { activeSession, createTerminalState, createWorkspaceSession } from "../../model/state"
import { context, describe, expect, it } from "../../test"
import type { BackendAction } from "../port"
import { itemOf } from "./companions"
import { id, keptSummary, scripted } from "./scripted"
import type { ListedCompanions } from "./seed"

const session = id(8)
const target = { projectId: "p", workspaceSessionId: session }
const [first, second] = [id(1), id(2)]

const runnerItem = (itemId: string, change: Partial<CompanionItem> = {}): CompanionItem => ({
  id: itemId,
  sessionId: session,
  holder: { terminalId: first },
  kind: "file",
  name: `${itemId}.ts`,
  detail: "",
  path: `/p/${itemId}.ts`,
  url: null,
  lines: null,
  held: false,
  by: "agent",
  from: { terminalId: first, handle: "t1" },
  version: 1,
  asked: false,
  shownAt: 1,
  plan: null,
  ...change,
})
const runnerWindow = (windowId: string, itemId: string): CompanionWindow => ({
  id: windowId,
  sessionId: session,
  itemId,
  title: `${itemId}.ts`,
  titleSource: { kind: "default" },
})
const notes = runnerItem("00000000-0000-4000-8000-0000000000a1")
const hero = runnerItem("00000000-0000-4000-8000-0000000000a2")
// On the second terminal's bar, pointing where `notes` does.
const twin = runnerItem("00000000-0000-4000-8000-0000000000a3", {
  holder: { terminalId: second },
  path: notes.path,
})
const windowId = "00000000-0000-4000-8000-0000000000b1"
const live = (terminalId: string): TerminalSummary =>
  keptSummary(terminalId, session, { started: true, run: 1 })

// The adapter over a scripted runner whose shown session has two live terminals, with
// `notes` on the first one's bar unless `companions` says otherwise. What the adapter
// reports reaches the workspace it sees. `respond` is how the runner answers the
// person's changes.
const open = ({
  respond,
  createSession,
  companions = { items: [notes], windows: [] },
}: {
  respond?: (call: string, input: unknown) => Promise<unknown>
  createSession?: () => Promise<unknown>
  companions?: ListedCompanions
} = {}) => {
  const app = scripted({
    shown: [
      { id: first, lastProcess: "" },
      { id: second, lastProcess: "" },
    ],
    listed: [live(first), live(second)],
    companions,
    apply: true,
    ...(respond ? { respond } : {}),
    ...(createSession ? { createSession } : {}),
  })
  // What the adapter reported of items and windows.
  const reported = (): BackendAction[] =>
    app.received.filter((action) => /^(item|window)\//.test(action.type))
  const state = () => activeSession(app.workspace())!.state
  const shown = () =>
    state()
      .items.map((item) => item.id)
      .toSorted()
  return { ...app, reported, state, shown }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const sync = (app: ReturnType<typeof open>, ...changes: (CompanionItem | CompanionWindow)[]) => {
  app.items.push({ type: "reset" })
  for (const change of changes)
    app.items.push(
      "itemId" in change ? { type: "window", window: change } : { type: "item", item: change },
    )
  app.items.push({ type: "synced" })
}

describe("the runner's items and windows", () => {
  context("as the session is seeded", () => {
    it("holds what the runner lists", () => {
      const app = open()
      const listed = app.backend.seed.projects[0]!.sessions.find((each) => each.id === session)
      expect(listed?.items.map((item) => item.id)).toEqual([notes.id])
      app.stop()
    })

    it("holds back a window whose item isn't listed, until the item comes", async () => {
      const app = open({ companions: { items: [], windows: [runnerWindow(windowId, hero.id)] } })
      expect(app.state().roster.windows).toEqual([])
      app.items.push({ type: "reset" })
      app.items.push({ type: "window", window: runnerWindow(windowId, hero.id) })
      app.items.push({ type: "synced" })
      app.items.push({ type: "item", item: { ...hero, holder: { windowId } } })
      await vi.waitFor(() =>
        expect(app.state().roster.windows.map((each) => each.id)).toEqual([windowId]),
      )
      app.stop()
    })
  })

  context("when the runner lists everything again", () => {
    it("applies the list whole at synced, dropping what it no longer has first", async () => {
      const app = open()
      app.items.push({ type: "reset" })
      app.items.push({ type: "window", window: runnerWindow(windowId, hero.id) })
      app.items.push({ type: "item", item: { ...hero, holder: { windowId } } })
      await settle()
      expect(app.reported()).toEqual([])
      app.items.push({ type: "synced" })
      await vi.waitFor(() => expect(app.reported()).toHaveLength(3))
      expect(app.reported().map((action) => action.type)).toEqual([
        "item/remove",
        "item/upsert",
        "window/upsert",
      ])
      expect(app.shown()).toEqual([hero.id])
      expect(app.state().roster.windows.map((each) => each.id)).toEqual([windowId])
      app.stop()
    })

    it("reports nothing of what the workspace already holds as listed", async () => {
      const app = open()
      sync(app, notes)
      await settle()
      await settle()
      expect(app.reported()).toEqual([])
      app.stop()
    })

    it("brings back what the workspace lost, as after a refused move replaced a twin", async () => {
      const app = open({
        companions: { items: [notes, twin], windows: [] },
        respond: async (call) => {
          if (call === "move") throw new RunnerError("CONFLICT", "Another session")
        },
      })
      // The workspace lost the twin, as a move does before the runner answers.
      app.commit({ type: "item/remove", target, itemId: itemIdOf(twin.id) })
      expect(app.shown()).toEqual([notes.id])
      sync(app, notes, twin)
      await vi.waitFor(() => expect(app.shown()).toEqual([notes.id, twin.id].toSorted()))
      app.stop()
    })
  })

  context("after it caught up", () => {
    it("shows a window only once its item came, and nothing it references goes missing", async () => {
      const app = open()
      sync(app, notes)
      app.items.push({ type: "window", window: runnerWindow(windowId, hero.id) })
      await settle()
      expect(app.state().roster.windows).toEqual([])
      app.items.push({ type: "item", item: { ...hero, holder: { windowId } } })
      app.items.push({ type: "itemRemoved", itemId: notes.id, sessionId: session })
      await vi.waitFor(() =>
        expect(app.reported().map((action) => action.type)).toEqual([
          "item/upsert",
          "window/upsert",
          "item/remove",
        ]),
      )
      expect(app.state().roster.windows.map((each) => each.id)).toEqual([windowId])
      app.stop()
    })

    it("keeps an item held by a window not reported yet on no bar", async () => {
      const app = open()
      sync(app, notes)
      app.items.push({ type: "item", item: { ...hero, holder: { windowId } } })
      await vi.waitFor(() => expect(app.shown()).toContain(hero.id))
      expect(app.state().bars[first]?.order ?? []).not.toContain(hero.id)
      app.stop()
    })
  })

  context("when the person changes them", () => {
    it("sends each change to the runner", async () => {
      const app = open()
      app.commit(
        { type: "item/move", target, itemIds: [itemIdOf(notes.id)], terminalId: second },
        {
          type: "item/undock",
          target,
          itemId: itemIdOf(notes.id),
          window: {
            id: windowId,
            itemId: itemIdOf(notes.id),
            name: "notes",
            titleSource: { kind: "default" },
          },
        },
        { type: "terminal/rename", target, terminalId: windowId, name: "Notes" },
      )
      app.backend.resetTitle!({ ...target, terminalId: windowId })
      app.commit({ type: "item/close", target, itemId: itemIdOf(notes.id) })
      await vi.waitFor(() =>
        expect(app.calls.map((call) => call.call).filter((call) => call !== "create")).toEqual([
          "move",
          "undock",
          "rename window",
          "reset window",
          "close item",
        ]),
      )
      expect(app.of("move")).toEqual([[notes.id, second]])
      expect(app.of("undock")).toEqual([[notes.id, windowId]])
      expect(app.of("rename window")).toEqual([[windowId, "Notes"]])
      expect(app.of("rename")).toEqual([])
      expect(app.reported()).toEqual([])
      app.stop()
    })

    it("puts back the item and the twin it replaced when the runner refuses a move", async () => {
      const app = open({
        companions: { items: [notes, twin], windows: [] },
        respond: async (call) => {
          if (call === "move") throw new RunnerError("CONFLICT", "Another session")
        },
      })
      app.commit({ type: "item/move", target, itemIds: [itemIdOf(notes.id)], terminalId: second })
      expect(app.shown()).toEqual([notes.id])
      await vi.waitFor(() => expect(app.shown()).toEqual([notes.id, twin.id].toSorted()))
      expect(app.state().items.find((item) => item.id === notes.id)?.holder).toEqual({
        terminalId: first,
      })
      app.stop()
    })

    it("takes away a window the runner refused, putting its item back", async () => {
      const app = open({
        respond: async (call) => {
          if (call === "undock") throw new RunnerError("CONFLICT", "Taken")
        },
      })
      app.commit({
        type: "item/undock",
        target,
        itemId: itemIdOf(notes.id),
        window: {
          id: windowId,
          itemId: itemIdOf(notes.id),
          name: "notes",
          titleSource: { kind: "default" },
        },
      })
      await vi.waitFor(() => expect(app.reported()).toHaveLength(2))
      expect(app.state().roster.windows).toEqual([])
      expect(app.state().bars[first]?.order).toContain(notes.id)
      app.stop()
    })

    it("puts an item back where the runner last answered, as in the window it undocked to", async () => {
      const app = open({
        respond: async (call) => {
          if (call === "undock") return runnerWindow(windowId, notes.id)
          if (call === "move") throw new RunnerError("CONFLICT", "Another session")
        },
      })
      const window = {
        id: windowId,
        itemId: itemIdOf(notes.id),
        name: "notes",
        titleSource: { kind: "default" },
      } as const
      app.commit({ type: "item/undock", target, itemId: itemIdOf(notes.id), window })
      await vi.waitFor(() => expect(app.of("undock")).toHaveLength(1))
      app.commit({ type: "item/move", target, itemIds: [itemIdOf(notes.id)], terminalId: second })
      await vi.waitFor(() => expect(app.state().items[0]?.holder).toEqual({ windowId }))
      expect(app.state().roster.windows.map((each) => each.id)).toEqual([windowId])
      app.stop()
    })

    it("forgets the window an item left once a move is answered", async () => {
      const app = open({
        companions: {
          items: [{ ...notes, holder: { windowId } }],
          windows: [runnerWindow(windowId, notes.id)],
        },
        respond: async (call, input) => {
          if (call === "move") return { ...notes, holder: { terminalId: (input as string[])[1] } }
          if (call === "close item") throw new RunnerError("CONFLICT", "Busy")
        },
      })
      expect(app.state().roster.windows.map((each) => each.id)).toEqual([windowId])
      app.commit({ type: "item/move", target, itemIds: [itemIdOf(notes.id)], terminalId: second })
      await vi.waitFor(() => expect(app.of("move")).toHaveLength(1))
      app.commit({ type: "item/close", target, itemId: itemIdOf(notes.id) })
      // Put back on the bar it moved to, without the window it left.
      await vi.waitFor(() => expect(app.shown()).toEqual([notes.id]))
      expect(app.state().items[0]?.holder).toEqual({ terminalId: second })
      expect(app.state().roster.windows).toEqual([])
      app.stop()
    })

    it("takes closing what the runner no longer has as done", async () => {
      const app = open({
        respond: async (call) => {
          if (call === "close item") throw new RunnerError("NOT_FOUND", "Gone")
        },
      })
      app.commit({ type: "item/close", target, itemId: itemIdOf(notes.id) })
      await vi.waitFor(() => expect(app.of("close item")).toHaveLength(1))
      await settle()
      expect(app.reported()).toEqual([])
      app.stop()
    })
  })

  context("onto a terminal the runner hasn't created yet", () => {
    it("moves once the terminal exists there, and tries again if it wasn't yet", async () => {
      let tries = 0
      const app = open({
        respond: async (call) => {
          if (call === "move" && (tries += 1) === 1)
            throw new RunnerError("TERMINAL_NOT_FOUND", "Not yet")
          return undefined
        },
      })
      app.commit({ type: "item/move", target, itemIds: [itemIdOf(notes.id)], terminalId: second })
      await vi.waitFor(() => expect(app.of("move")).toHaveLength(2))
      await settle()
      expect(app.reported()).toEqual([])
      expect(app.state().items[0]?.holder).toEqual({ terminalId: second })
      app.stop()
    })
  })

  context("in a session the runner hasn't finished creating", () => {
    it("sends the person's changes only once the session exists there", async () => {
      let created!: () => void
      const app = open({
        createSession: () => new Promise<void>((resolve) => (created = resolve)),
      })
      const fresh = id(7)
      const there = { projectId: "p", workspaceSessionId: fresh }
      const item = itemIdOf(hero.id)
      app.commit(
        {
          type: "session/add",
          projectId: "p",
          activate: false,
          session: createWorkspaceSession(
            { name: "Fresh", state: createTerminalState([], "grid", "grid") },
            { id: fresh, now: 1 },
          ),
        },
        { type: "item/upsert", target: there, item: { ...itemOf(hero), id: item } },
        { type: "item/move", target: there, itemIds: [item], terminalId: first },
        {
          type: "item/undock",
          target: there,
          itemId: item,
          window: { id: windowId, itemId: item, name: "hero", titleSource: { kind: "default" } },
        },
        { type: "terminal/rename", target: there, terminalId: windowId, name: "Hero" },
      )
      await vi.waitFor(() => expect(app.of("create session")).toHaveLength(1))
      await settle()
      const sent = () =>
        app.calls
          .map((call) => call.call)
          .filter((call) => ["create session", "move", "undock", "rename window"].includes(call))
      expect(sent()).toEqual(["create session"])
      created()
      await vi.waitFor(() =>
        expect(sent()).toEqual(["create session", "move", "undock", "rename window"]),
      )
      app.stop()
    })
  })
})
