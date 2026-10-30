import { itemIdOf, type Item } from "./items"
import { messagesKey } from "./items/companion-bar"
import { orderedTiles } from "./roster"
import { activeSession, workspaceReducer, type WorkspaceAction } from "./state"
import { context, describe, expect, it } from "./test"
import { itemFixture, terminalFixture, workspaceFixture } from "./testing"
import type { CompanionWindowMeta, Workspace, WorkspaceState } from "./types"

const target = { projectId: "project", workspaceSessionId: "initial" }
const hero = itemFixture("hero", "01", { kind: "image", name: "hero.png", path: "/p/hero.png" })
const notes = itemFixture("notes", "01")
const windowFor = (item: Item, id = "w1"): CompanionWindowMeta => ({
  id,
  home: "undocked",
  itemId: item.id,
  name: item.name,
  titleSource: { kind: "default" },
})

const apply = (workspace: Workspace, ...actions: WorkspaceAction[]): Workspace =>
  actions.reduce(workspaceReducer, workspace)
const stateOf = (workspace: Workspace): WorkspaceState => activeSession(workspace)!.state
const shown = (...items: Item[]): Workspace =>
  apply(
    workspaceFixture(),
    ...items.map((item) => ({ type: "item/upsert", target, item }) as const),
  )
const run = (from: Workspace, ...actions: WorkspaceAction[]): WorkspaceState =>
  stateOf(apply(from, ...actions))

describe("items in the workspace", () => {
  context("when the backend reports something new", () => {
    it("joins its terminal's bar, last, as new", () => {
      const state = stateOf(shown(notes, hero))
      expect(state.items).toEqual([notes, hero])
      expect(state.bars["01"]).toEqual({
        order: [notes.id, hero.id],
        hidden: [],
        stack: [],
        open: false,
      })
      expect(state.fresh).toEqual({ [notes.id]: true, [hero.id]: true })
    })

    it("opens when the person asked for it, and isn't new", () => {
      const state = stateOf(shown({ ...hero, openAsked: true }))
      expect(state.bars["01"]).toMatchObject({ stack: [hero.id], open: true })
      expect(state.fresh).toEqual({})
    })

    it("opens on top of what the person has open, which waits behind it", () => {
      const reading = apply(shown(notes), {
        type: "bar/open",
        target,
        terminalId: "01",
        key: notes.id,
      })
      const state = run(reading, {
        type: "item/upsert",
        target,
        item: { ...hero, openAsked: true },
      })
      expect(state.bars["01"]).toMatchObject({ stack: [notes.id, hero.id], open: true })
    })

    it("takes what the person uncovers as seen, though it was rewritten behind", () => {
      const reading = apply(
        shown(notes, hero),
        { type: "bar/open", target, terminalId: "01", key: notes.id },
        { type: "bar/open", target, terminalId: "01", key: hero.id },
        { type: "item/upsert", target, item: { ...notes, version: notes.version + 1 } },
      )
      expect(stateOf(reading).fresh).toEqual({ [notes.id]: true })
      const state = run(reading, { type: "bar/minimize", target, terminalId: "01", key: hero.id })
      expect(state.bars["01"]).toMatchObject({ stack: [notes.id], open: true })
      expect(state.fresh).toEqual({})
    })

    it("never opens something an agent showed that may hold secrets", () => {
      const state = stateOf(shown({ ...notes, openAsked: true, secret: true, by: "agent" }))
      expect(state.bars["01"]).toMatchObject({ stack: [], open: false })
      expect(state.fresh).toEqual({ [notes.id]: true })
    })

    it("opens something the person attached though it may hold secrets, for its pane to gate", () => {
      const state = stateOf(shown({ ...notes, openAsked: true, secret: true, by: "person" }))
      expect(state.bars["01"]).toMatchObject({ stack: [notes.id], open: true })
      expect(state.fresh).toEqual({})
    })
  })

  context("when an agent asks to open something on a terminal that isn't selected", () => {
    const asked = { ...hero, holder: { terminalId: "02" }, openAsked: true } satisfies Item
    const askedAlso = itemFixture("other", "02", { openAsked: true })
    // In Focus, as on the Canvas: what waits stays shut.
    const shownOff = (...items: Item[]): Workspace =>
      items.reduce(
        (next, item) => workspaceReducer(next, { type: "item/upsert", target, item }),
        workspaceFixture({ view: "focus" }),
      )
    const select = (id: string): WorkspaceAction => ({
      type: "terminal/select",
      target,
      terminalId: id,
    })

    it("leaves it new and waiting, the pane shut", () => {
      const state = stateOf(shownOff(asked))
      expect(state.bars["02"]).toMatchObject({ order: [hero.id], stack: [], open: false })
      expect(state.fresh).toEqual({ [hero.id]: true })
      expect(state.waiting).toEqual([hero.id])
    })

    it("opens it when its terminal is selected, and stops waiting", () => {
      const state = run(shownOff(asked), select("02"))
      expect(state.bars["02"]).toMatchObject({ stack: [hero.id], open: true })
      expect(state.fresh).toEqual({})
      expect(state.waiting).toEqual([])
    })

    it("opens the last to come on top when it is selected another way", () => {
      const other = askedAlso
      const waiting = shownOff(asked, other)
      expect(stateOf(waiting).waiting).toEqual([hero.id, other.id])
      const state = run(waiting, { type: "terminal/close", target, terminalId: "01" })
      expect(state.selected).toBe("02")
      expect(state.bars["02"]).toMatchObject({ stack: [hero.id, other.id], open: true })
      expect(state.waiting).toEqual([])
    })

    it("opens nothing when another terminal is selected", () => {
      const state = run(shownOff(asked), select("01"))
      expect(state.bars["02"]).toMatchObject({ stack: [], open: false })
      expect(state.waiting).toEqual([hero.id])
    })

    it("stops waiting once the person opens, hides or closes it first", () => {
      const waiting = shownOff(asked)
      const opened = run(waiting, { type: "bar/open", target, terminalId: "02", key: hero.id })
      expect(opened.waiting).toEqual([])
      const hidden = run(waiting, { type: "bar/hide", target, terminalId: "02", key: hero.id })
      expect(hidden.waiting).toEqual([])
      const closed = run(waiting, { type: "item/close", target, itemId: hero.id })
      expect(closed.waiting).toEqual([])
      const moved = run(waiting, {
        type: "item/move",
        target,
        itemIds: [hero.id],
        terminalId: "01",
      })
      expect(moved.waiting).toEqual([])
    })

    it("waits in its new place when shown again, or no longer when the ask is dropped", () => {
      const other = askedAlso
      const waiting = shownOff(asked, other)
      const again = run(waiting, {
        type: "item/upsert",
        target,
        item: { ...asked, version: asked.version + 1 },
      })
      expect(again.waiting).toEqual([other.id, hero.id])
      const quiet = run(waiting, {
        type: "item/upsert",
        target,
        item: { ...asked, version: asked.version + 1, openAsked: false },
      })
      expect(quiet.waiting).toEqual([other.id])
      expect(quiet.fresh).toHaveProperty(hero.id)
    })

    context("in Grid, where nothing moves as a pane opens", () => {
      const inGrid = (...items: Item[]): Workspace =>
        items.reduce(
          (next, item) => workspaceReducer(next, { type: "item/upsert", target, item }),
          workspaceFixture({ view: "grid" }),
        )

      it("opens it in its window as it waits, still to be told of", () => {
        const state = stateOf(inGrid(asked))
        expect(state.selected).toBe("01")
        expect(state.bars["02"]).toMatchObject({ stack: [hero.id], open: true })
        expect(state.fresh).toEqual({})
        expect(state.waiting).toEqual([hero.id])
      })

      it("stops waiting once its terminal is selected, or the person puts it away", () => {
        expect(run(inGrid(asked), select("02")).waiting).toEqual([])
        const minimized = run(inGrid(asked), {
          type: "bar/minimize",
          target,
          terminalId: "02",
          key: hero.id,
        })
        expect(minimized.waiting).toEqual([])
        const closed = run(inGrid(asked), { type: "bar/close", target, terminalId: "02" })
        expect(closed.waiting).toEqual([])
      })

      it("counts what putting one away uncovers as seen too", () => {
        const both = inGrid(asked, askedAlso)
        expect(stateOf(both).waiting).toEqual([hero.id, askedAlso.id])
        const state = run(both, {
          type: "bar/minimize",
          target,
          terminalId: "02",
          key: askedAlso.id,
        })
        expect(state.bars["02"]).toMatchObject({ stack: [hero.id], open: true })
        expect(state.waiting).toEqual([])
      })
    })

    it("still never opens what may hold secrets", () => {
      const secret = { ...asked, secret: true, by: "agent" } satisfies Item
      const state = run(shownOff(secret), select("02"))
      expect(state.waiting).toEqual([])
      expect(state.bars["02"]).toMatchObject({ stack: [], open: false })
      expect(state.fresh).toEqual({ [hero.id]: true })
    })

    it("opens at once on the selected terminal", () => {
      const state = stateOf(shown({ ...asked, holder: { terminalId: "01" } }))
      expect(state.bars["01"]).toMatchObject({ stack: [hero.id], open: true })
      expect(state.waiting).toEqual([])
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
      expect(state.bars["02"]).toMatchObject({ stack: [notes.id], open: true })
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

  context("when the person opens a file in the project window", () => {
    const opened = (name: string, version = 1): Item =>
      itemFixture("project", "01", {
        name,
        path: `/project/${name}`,
        by: "person",
        from: null,
        openAsked: true,
        version,
        holder: { windowId: "pw" },
      })
    const windowOf = (item: Item): CompanionWindowMeta => ({
      ...windowFor(item, "pw"),
      home: "project",
    })
    const open = (item: Item): WorkspaceAction => ({
      type: "project/open",
      target,
      item,
      window: windowOf(item),
    })
    const empty = apply(workspaceFixture({ terminals: 0 }))

    it("places the window and selects it, with no terminal open", () => {
      const state = run(empty, open(opened("a.ts")))
      expect(state.roster.windows).toEqual([windowOf(opened("a.ts"))])
      expect(state.selected).toBe("pw")
      expect(state.layout.canvas.geometry).toHaveProperty("pw")
      expect(state.items).toEqual([opened("a.ts")])
      expect(orderedTiles(state.roster).map((tile) => tile.id)).toEqual(["pw"])
    })

    it("re-points the one window, and its name follows", () => {
      const state = run(empty, open(opened("a.ts")), open(opened("b.ts", 2)))
      expect(state.roster.windows.map((window) => window.name)).toEqual(["b.ts"])
      expect(state.items.map((item) => [item.name, item.version])).toEqual([["b.ts", 2]])
      expect(state.selected).toBe("pw")
    })

    it("keeps what the watch reported of a later re-point, applied before this answer", () => {
      const later = opened("b.ts", 2)
      const state = run(
        empty,
        { type: "item/upsert", target, item: later },
        { type: "window/upsert", target, window: windowOf(later) },
        open(opened("a.ts")),
      )
      expect(state.items.map((item) => [item.name, item.version])).toEqual([["b.ts", 2]])
      expect(state.roster.windows.map((window) => window.name)).toEqual(["b.ts"])
      expect(state.selected).toBe("pw")
      const fresh = run(empty, { type: "item/upsert", target, item: later }, open(opened("a.ts")))
      expect(fresh.roster.windows.map((window) => window.name)).toEqual(["b.ts"])
    })

    it("agrees with the watch's events, in either order", () => {
      const item = opened("a.ts")
      const events: WorkspaceAction[] = [
        { type: "item/upsert", target, item },
        { type: "window/upsert", target, window: windowOf(item) },
      ]
      // The session had no such window before the open, as the command tells it.
      const made = { ...open(item), made: true }
      const before = run(workspaceFixture(), ...events, made)
      const after = run(workspaceFixture(), made, ...events)
      const alone = run(workspaceFixture(), made)
      expect(before).toEqual(alone)
      expect(after).toEqual(alone)
      expect(orderedTiles(alone.roster).map((tile) => tile.id)).toEqual(["01", "02", "pw"])
    })

    it("closes with its item, and a later open makes it again", () => {
      const closed = run(empty, open(opened("a.ts")), {
        type: "item/close",
        target,
        itemId: opened("a.ts").id,
      })
      expect(closed.roster.windows).toEqual([])
      expect(closed.items).toEqual([])
      const again = run(
        apply(empty, open(opened("a.ts")), {
          type: "item/close",
          target,
          itemId: opened("a.ts").id,
        }),
        open(opened("c.ts")),
      )
      expect(again.roster.windows.map((window) => window.name)).toEqual(["c.ts"])
      expect(again.selected).toBe("pw")
    })

    it("places beside the selected terminal when there are some", () => {
      const state = run(workspaceFixture(), open(opened("a.ts")))
      expect(orderedTiles(state.roster).map((tile) => tile.id)).toEqual(["01", "02", "pw"])
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
      expect(state.bars["01"]).toMatchObject({ stack: [notes.id], open: true })
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
      titleSource: { kind: "agent", by: "fox" },
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

describe("terminals agents open", () => {
  // 01 and 02 as the person opened them; the rest as agents open them.
  const handles: Record<string, string> = {
    "01": "moth",
    "02": "wren",
    "03": "fern",
    "04": "kite",
    "05": "lark",
    "06": "hawk",
  }
  const named = (id: string): WorkspaceAction => ({
    type: "terminal/update",
    target,
    terminalId: id,
    handle: handles[id]!,
  })
  // Terminal `number`, as the agent in `from` asks for it, and its backend then names it.
  const opened = (number: number, from: string): WorkspaceAction[] => {
    const by = handles[from]
    const terminal = { ...terminalFixture(number, "~/project"), ...(by && { openedBy: by }) }
    return [
      { type: "terminal/add", target, terminal, anchor: from, select: false },
      named(terminal.id),
    ]
  }
  const order = (state: WorkspaceState) => orderedTiles(state.roster).map((tile) => tile.id)
  const handled = apply(workspaceFixture(), named("01"), named("02"))

  it("lists each under its opener, after the ones it opened before", () => {
    const state = run(handled, ...opened(3, "01"), ...opened(4, "01"))
    expect(order(state)).toEqual(["01", "03", "04", "02"])
  })

  it("lists one a teammate opened in its lead's group, under the teammate", () => {
    const state = run(
      handled,
      ...opened(3, "01"),
      ...opened(4, "01"),
      ...opened(5, "03"),
      ...opened(6, "01"),
    )
    expect(order(state)).toEqual(["01", "03", "05", "04", "06", "02"])
  })

  it("keeps teammates in the order they came when only their lead is known", () => {
    // As the demo adds a lead's helpers at once: led by it, before anything says who opened them.
    const helper = (number: number): WorkspaceAction => ({
      type: "terminal/add",
      target,
      terminal: { ...terminalFixture(number, "~/project"), ledBy: "moth" },
      anchor: "01",
      select: false,
    })
    const state = run(handled, helper(3), named("03"), helper(4), named("04"), helper(5))
    expect(order(state)).toEqual(["01", "03", "04", "05", "02"])
  })

  it("follows the order the person dragged the list into", () => {
    const dragged = apply(handled, { type: "terminal/reorder", target, tabOrder: ["02", "01"] })
    expect(order(run(dragged, ...opened(3, "01")))).toEqual(["02", "01", "03"])
    expect(order(run(dragged, ...opened(3, "02")))).toEqual(["02", "03", "01"])
  })

  context("when an agent leads a terminal that already exists", () => {
    const lead = (id: string, ledBy: string | null): WorkspaceAction => ({
      type: "terminal/update",
      target,
      terminalId: id,
      ledBy,
    })
    const three = apply(
      handled,
      { type: "terminal/add", target, terminal: terminalFixture(3, "~/project"), select: false },
      named("03"),
    )

    it("lists it under its lead, as one opened with a brief", () => {
      expect(order(run(three, lead("03", "moth")))).toEqual(["01", "03", "02"])
    })

    it("goes after the lead wherever the person dragged it", () => {
      const dragged = apply(three, {
        type: "terminal/reorder",
        target,
        tabOrder: ["02", "03", "01"],
      })
      expect(order(run(dragged, lead("03", "moth")))).toEqual(["02", "01", "03"])
    })

    it("moves nothing on a restore, which seeds the lead, nor on the same lead announced again", () => {
      // As the runner adapter's seed builds it: led from the start, in the saved order.
      const restored = apply(
        handled,
        {
          type: "terminal/add",
          target,
          terminal: { ...terminalFixture(3, "~/project"), ledBy: "moth" },
          select: false,
        },
        named("03"),
        { type: "terminal/reorder", target, tabOrder: ["02", "01", "03"] },
      )
      expect(order(run(restored))).toEqual(["02", "01", "03"])
      expect(order(run(restored, lead("03", "moth")))).toEqual(["02", "01", "03"])
    })

    it("moves nothing on a change of lead or a release", () => {
      const led = apply(three, lead("03", "moth"))
      const dragged = apply(led, { type: "terminal/reorder", target, tabOrder: ["02", "01", "03"] })
      expect(order(run(dragged, lead("03", "wren")))).toEqual(["02", "01", "03"])
      expect(order(run(dragged, lead("03", null)))).toEqual(["02", "01", "03"])
    })

    it("stays put when no terminal in the session has that handle", () => {
      expect(order(run(three, lead("03", "nobody")))).toEqual(order(run(three)))
    })
  })

  it("leaves windows after the terminals the person opens later", () => {
    const undocked = apply(
      shown(hero),
      { type: "item/undock", target, itemId: hero.id, window: windowFor(hero) },
      named("01"),
      named("02"),
    )
    const own = terminalFixture(4, "~/project")
    const after = run(undocked, ...opened(3, "01"), { type: "terminal/add", target, terminal: own })
    expect(order(after)).toEqual(["01", "03", "02", "04", "w1"])
  })

  it("goes last when its opener isn't in the session, as the person's own do", () => {
    expect(order(run(handled, ...opened(3, "gone")))).toEqual(["01", "02", "03"])
    const own = terminalFixture(3, "~/project")
    expect(order(run(handled, { type: "terminal/add", target, terminal: own }))).toEqual([
      "01",
      "02",
      "03",
    ])
  })
})
