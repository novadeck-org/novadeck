import { context, describe, expect, it } from "../test"
import { itemFixture, workspaceFixture } from "../test/fixtures"
import { itemIdOf, type CompanionItem } from "./companion"
import { messagesKey } from "./companion-bar"
import { orderedTiles } from "./roster"
import { activeSession, workspaceReducer, type WorkspaceAction } from "./state"
import type { CompanionWindowMeta, Workspace, WorkspaceState } from "./types"

const target = { projectId: "project", workspaceSessionId: "initial" }
const hero = itemFixture("hero", "01", { kind: "image", name: "hero.png", path: "/p/hero.png" })
const notes = itemFixture("notes", "01")
const windowFor = (item: CompanionItem, id = "w1"): CompanionWindowMeta => ({
  id,
  itemId: item.id,
  name: item.name,
  titleSource: { kind: "default" },
})

const apply = (workspace: Workspace, ...actions: WorkspaceAction[]): Workspace =>
  actions.reduce(workspaceReducer, workspace)
const stateOf = (workspace: Workspace): WorkspaceState => activeSession(workspace)!.state
const shown = (...items: CompanionItem[]): Workspace =>
  apply(
    workspaceFixture(),
    ...items.map((item) => ({ type: "item/upsert", target, item }) as const),
  )
const run = (from: Workspace, ...actions: WorkspaceAction[]): WorkspaceState =>
  stateOf(apply(from, ...actions))

describe("companion items in the workspace", () => {
  context("when the backend reports something new", () => {
    it("joins its terminal's bar, last, as new", () => {
      const state = stateOf(shown(notes, hero))
      expect(state.items).toEqual([notes, hero])
      expect(state.bars["01"]).toEqual({
        order: [notes.id, hero.id],
        hidden: [],
        tab: null,
        open: false,
      })
      expect(state.fresh).toEqual({ [notes.id]: true, [hero.id]: true })
    })

    it("opens when the person asked for it, and isn't new", () => {
      const state = stateOf(shown({ ...hero, asked: true }))
      expect(state.bars["01"]).toMatchObject({ tab: hero.id, open: true })
      expect(state.fresh).toEqual({})
    })

    it("never opens something that may hold secrets", () => {
      const state = stateOf(shown({ ...notes, asked: true, held: true }))
      expect(state.bars["01"]).toMatchObject({ tab: null, open: false })
      expect(state.fresh).toEqual({ [notes.id]: true })
    })
  })

  context("when the backend reports an item it reported before", () => {
    it("updates it in place, new again only when shown again", () => {
      const seen = apply(shown(notes, hero), {
        type: "bar/open",
        target,
        terminalId: "01",
        key: notes.id,
      })
      const renamed = run(seen, {
        type: "item/upsert",
        target,
        item: { ...notes, name: "other.ts" },
      })
      expect(renamed.items[0]!.name).toBe("other.ts")
      expect(renamed.fresh).toEqual({ [hero.id]: true })
      const again = run(
        seen,
        { type: "bar/close", target, terminalId: "01" },
        {
          type: "item/upsert",
          target,
          item: { ...notes, version: 2 },
        },
      )
      expect(again.fresh).toHaveProperty(notes.id)
      expect(again.bars["01"]!.order).toEqual([notes.id, hero.id])
    })

    it("isn't new while the pane shows it", () => {
      const reading = apply(shown(notes), {
        type: "bar/open",
        target,
        terminalId: "01",
        key: notes.id,
      })
      expect(
        run(reading, { type: "item/upsert", target, item: { ...notes, version: 2 } }).fresh,
      ).toEqual({})
    })

    it("brings a hidden plan back, last", () => {
      const plan = itemFixture("plan", "01", {
        kind: "plan",
        plan: { agent: "Codex", role: "root", source: "file" },
      })
      const hidden = apply(shown(plan, notes), {
        type: "bar/hide",
        target,
        terminalId: "01",
        key: plan.id,
      })
      expect(stateOf(hidden).bars["01"]).toMatchObject({ order: [notes.id], hidden: [plan.id] })
      const back = run(hidden, { type: "item/upsert", target, item: { ...plan, version: 2 } })
      expect(back.bars["01"]).toMatchObject({ order: [notes.id, plan.id], hidden: [] })
    })

    it("moves it between bars when its holder changed", () => {
      const state = run(shown(notes), {
        type: "item/upsert",
        target,
        item: { ...notes, holder: { terminalId: "02" } },
      })
      expect(state.bars["01"]!.order).toEqual([])
      expect(state.bars["02"]!.order).toEqual([notes.id])
    })
  })

  context("when the person moves items onto another bar", () => {
    it("puts each last there, takes it off its own, and closes a pane open to it", () => {
      const open = apply(shown(notes, hero), {
        type: "bar/open",
        target,
        terminalId: "01",
        key: hero.id,
      })
      const state = run(open, {
        type: "item/move",
        target,
        itemIds: [hero.id, notes.id],
        terminalId: "02",
      })
      expect(state.items.map((item) => item.holder)).toEqual([
        { terminalId: "02" },
        { terminalId: "02" },
      ])
      expect(state.bars["02"]!.order).toEqual([hero.id, notes.id])
      expect(state.bars["01"]).toMatchObject({ order: [], open: false })
    })

    it("replaces what that bar already shows of the same file", () => {
      const twin = itemFixture("twin", "02", { path: notes.path })
      const state = run(shown(notes, twin), {
        type: "item/move",
        target,
        itemIds: [notes.id],
        terminalId: "02",
      })
      expect(state.items.map((item) => item.id)).toEqual([notes.id])
      expect(state.bars["02"]!.order).toEqual([notes.id])
    })

    it("opens the last one when asked, as docking does", () => {
      const state = run(shown(notes), {
        type: "item/move",
        target,
        itemIds: [notes.id],
        terminalId: "02",
        open: true,
      })
      expect(state.bars["02"]).toMatchObject({ tab: notes.id, open: true })
      expect(state.fresh).toEqual({})
    })

    it("ignores a terminal the session doesn't have", () => {
      const before = shown(notes)
      expect(
        apply(before, { type: "item/move", target, itemIds: [notes.id], terminalId: "99" }),
      ).toBe(before)
    })
  })

  context("when the person undocks an item", () => {
    const undocked = apply(shown(notes, hero), {
      type: "item/undock",
      target,
      itemId: hero.id,
      window: windowFor(hero),
      anchor: "01",
    })

    it("opens it in a window beside its terminal, selected", () => {
      const state = stateOf(undocked)
      expect(state.roster.windows).toEqual([windowFor(hero)])
      expect(state.selected).toBe("w1")
      expect(state.layout.canvas.geometry).toHaveProperty("w1")
      expect(state.items[1]!.holder).toEqual({ windowId: "w1" })
      expect(state.bars["01"]!.order).toEqual([notes.id])
      expect(state.fresh).not.toHaveProperty(hero.id)
    })

    it("lists the window among the tiles", () => {
      expect(orderedTiles(stateOf(undocked).roster).map((tile) => tile.id)).toEqual([
        "01",
        "02",
        "w1",
      ])
    })

    it("refuses a window that doesn't show it, or an id already taken", () => {
      expect(
        apply(undocked, {
          type: "item/undock",
          target,
          itemId: notes.id,
          window: windowFor(hero, "w2"),
        }),
      ).toBe(undocked)
      expect(
        apply(undocked, {
          type: "item/undock",
          target,
          itemId: notes.id,
          window: windowFor(notes, "01"),
        }),
      ).toBe(undocked)
    })

    it("docks back onto a bar, and the window goes", () => {
      const state = run(undocked, {
        type: "item/move",
        target,
        itemIds: [hero.id],
        terminalId: "01",
      })
      expect(state.roster.windows).toEqual([])
      expect(state.layout.canvas.geometry).not.toHaveProperty("w1")
      expect(state.bars["01"]!.order).toEqual([notes.id, hero.id])
      expect(state.selected).toBe("02")
    })

    it("treats the window as a tile: selected, hidden, renamed by the person", () => {
      const state = run(
        undocked,
        { type: "terminal/select", target, terminalId: "01" },
        { type: "terminal/select", target, terminalId: "w1" },
        { type: "terminal/visibility", target, terminalId: "w1", hidden: true },
        { type: "terminal/rename", target, terminalId: "w1", name: "Hero" },
      )
      expect(state.selected).toBe("w1")
      expect(state.layout.hidden).toEqual({ w1: true })
      expect(state.roster.windows[0]).toMatchObject({
        name: "Hero",
        titleSource: { kind: "person" },
      })
    })

    context("and then closes it", () => {
      it("deletes the item with its window, handing the selection on", () => {
        const state = run(undocked, { type: "item/close", target, itemId: hero.id })
        expect(state.items).toEqual([notes])
        expect(state.roster.windows).toEqual([])
        expect(state.selected).toBe("02")
      })
    })
  })

  context("when the person closes an item on a bar", () => {
    it("is gone from the bar and from what's new", () => {
      const state = run(shown(notes, hero), { type: "item/close", target, itemId: notes.id })
      expect(state.items).toEqual([hero])
      expect(state.bars["01"]!.order).toEqual([hero.id])
      expect(state.fresh).toEqual({ [hero.id]: true })
    })
  })

  context("when a terminal closes", () => {
    it("deletes what's on its bar and its bar, and keeps its windows", () => {
      const undocked = apply(shown(notes, hero), {
        type: "item/undock",
        target,
        itemId: hero.id,
        window: windowFor(hero),
      })
      const state = run(undocked, { type: "terminal/close", target, terminalId: "01" })
      expect(state.items.map((item) => item.id)).toEqual([hero.id])
      expect(state.bars).toEqual({})
      expect(state.roster.windows).toEqual([windowFor(hero)])
    })
  })

  context("when the backend reports windows", () => {
    it("lays out one it didn't know, without taking the selection", () => {
      const state = run(shown({ ...hero, holder: { windowId: "w1" } }), {
        type: "window/upsert",
        target,
        window: windowFor(hero),
      })
      expect(state.roster.windows).toEqual([windowFor(hero)])
      expect(state.layout.canvas.geometry).toHaveProperty("w1")
      expect(state.selected).toBe("01")
    })

    it("keeps an item held by a window not known yet on no bar, until the window comes", () => {
      const early = shown({ ...hero, holder: { windowId: "w1" } })
      expect(stateOf(early).items).toHaveLength(1)
      expect(stateOf(early).bars).toEqual({})
      const state = run(early, { type: "window/upsert", target, window: windowFor(hero) })
      expect(state.roster.windows).toEqual([windowFor(hero)])
    })

    it("renames one it knows, and forgets one that's gone", () => {
      const known = apply(shown({ ...hero, holder: { windowId: "w1" } }), {
        type: "window/upsert",
        target,
        window: windowFor(hero),
      })
      const renamed = { ...windowFor(hero), name: "Hero" }
      expect(run(known, { type: "window/upsert", target, window: renamed }).roster.windows).toEqual(
        [renamed],
      )
      expect(run(known, { type: "window/remove", target, windowId: "w1" }).roster.windows).toEqual(
        [],
      )
    })
  })

  context("when the person arranges a bar", () => {
    it("opens what they pick, which is no longer new", () => {
      const state = run(shown(notes), { type: "bar/open", target, terminalId: "01", key: notes.id })
      expect(state.bars["01"]).toMatchObject({ tab: notes.id, open: true })
      expect(state.fresh).toEqual({})
    })

    it("keeps the messages in their place once they come, and hides them", () => {
      const state = run(
        shown(notes),
        { type: "bar/arrive", target, terminalId: "01", key: messagesKey },
        {
          type: "bar/move",
          target,
          terminalId: "01",
          slots: [[notes.id], [messagesKey]],
          from: 1,
          to: 0,
        },
      )
      expect(state.bars["01"]!.order).toEqual([messagesKey, notes.id])
      const hidden = run(shown(notes), {
        type: "bar/hide",
        target,
        terminalId: "01",
        key: messagesKey,
      })
      expect(hidden.bars["01"]!.hidden).toEqual([messagesKey])
    })

    it("has no bar for a terminal the session doesn't have", () => {
      const before = workspaceFixture()
      expect(
        apply(before, { type: "bar/arrive", target, terminalId: "99", key: itemIdOf("x") }),
      ).toBe(before)
    })
  })
})

describe("a terminal's name from murmur", () => {
  it("takes murmur's name and who gave it from the backend's update", () => {
    const state = run(workspaceFixture(), {
      type: "terminal/update",
      target,
      terminalId: "01",
      name: "Checkout fix",
      titleSource: { kind: "murmur" },
    })
    expect(state.roster.terminals.find((terminal) => terminal.id === "01")).toMatchObject({
      name: "Checkout fix",
      titleSource: { kind: "murmur" },
    })
  })

  it("replaces an agent's name with murmur's as the source", () => {
    const named = apply(workspaceFixture(), {
      type: "terminal/update",
      target,
      terminalId: "01",
      titleSource: { kind: "agent", by: "t2" },
    })
    const state = run(named, {
      type: "terminal/update",
      target,
      terminalId: "01",
      titleSource: { kind: "murmur" },
    })
    expect(state.roster.terminals[0]?.titleSource).toEqual({ kind: "murmur" })
  })
})
