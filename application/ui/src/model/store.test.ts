import { describe, expect, it } from "vitest"

import { terminalFixture } from "../test/fixtures"
import { createTerminalState, workspaceReducer, type WorkspaceAction } from "./state"
import { createStore, createWorkspaceStore } from "./store"
import type { TerminalStatus, Workspace } from "./types"

const target = { projectId: "project", workspaceSessionId: "initial" }
const initial = (): Workspace => ({
  activeProjectId: "project",
  projects: [
    {
      id: "project",
      name: "Project",
      directory: "~/project",
      activeSessionId: "initial",
      history: ["initial", "other"].map((id) => ({
        id,
        name: id,
        visitedAt: 0,
        state: createTerminalState([terminalFixture(1, "~/project")], "grid", "grid"),
      })),
    },
  ],
})
const state = (workspace: Workspace) => workspace.projects[0]!.history[0]!.state

describe("workspace commands", () => {
  it("preserves a rename dispatched before adding a terminal in a transaction", () => {
    const store = createWorkspaceStore(initial())
    store.dispatch({ type: "terminal/rename", target, terminalId: "01", name: "Server" })
    store.transact([{ type: "terminal/add", target, terminal: terminalFixture(2, "~/project") }])
    expect(state(store.getSnapshot()).roster.terminals.map((terminal) => terminal.name)).toEqual([
      "Server",
      "Terminal 02",
    ])
  })

  it("constructs consecutive commands from the latest state before rendering", () => {
    const store = createWorkspaceStore(initial())
    const add = () =>
      store.transact((workspace) => [
        {
          type: "terminal/add",
          target,
          terminal: terminalFixture(state(workspace).roster.terminals.length + 1, "~/project"),
        },
      ])
    add()
    add()
    expect(state(store.getSnapshot()).roster.terminals.map((terminal) => terminal.id)).toEqual([
      "01",
      "02",
      "03",
    ])
  })

  it("publishes a complete transaction once and ignores obsolete targets", () => {
    const store = createWorkspaceStore(initial())
    let notifications = 0
    store.subscribe(() => notifications++)
    store.transact([
      { type: "terminal/rename", target, terminalId: "01", name: "Renamed" },
      { type: "terminal/select", target, terminalId: "" },
    ])
    expect(notifications).toBe(1)
    const previous = store.getSnapshot()
    store.dispatch({
      type: "terminal/rename",
      target: { ...target, projectId: "gone" },
      terminalId: "01",
      name: "Stale",
    })
    store.dispatch({
      type: "terminal/rename",
      target: { ...target, workspaceSessionId: "gone" },
      terminalId: "01",
      name: "Stale",
    })
    store.dispatch({ type: "terminal/rename", target, terminalId: "gone", name: "Stale" })
    expect(store.getSnapshot()).toBe(previous)
    expect(notifications).toBe(1)
    expect(previous.projects[0]!.history[1]!.state.roster.terminals[0]!.name).toBe("Terminal 01")
  })

  it("keeps layout initialization separate from terminal metadata", () => {
    const terminal = terminalFixture(1, "~/project")
    const canvasLayout = {
      geometry: { "01": { position: { x: 200, y: 300 }, width: 600, height: 400 } },
      minimized: {},
    }
    const terminalState = createTerminalState([terminal], "canvas", "canvas", { canvasLayout })
    expect(terminalState.layout.canvas).toBe(canvasLayout)
    expect(terminalState.roster).toEqual({ terminals: [terminal], windows: [], order: [] })
  })

  it("adding a terminal selects it and places it in every layout", () => {
    const store = createWorkspaceStore(initial())
    const before = state(store.getSnapshot())
    store.dispatch({
      type: "terminal/add",
      target,
      terminal: terminalFixture(2, "~/project"),
      canvasGeometry: { position: { x: 900, y: 500 }, width: 600, height: 400 },
      gridLayouts: {
        desktop: [
          { i: "02", x: 0, y: 0, w: 3, h: 4 },
          { i: "obsolete", x: 3, y: 0, w: 3, h: 4 },
        ],
      },
    })
    const added = state(store.getSnapshot())
    expect(added.selected).toBe("02")
    expect(added.roster.terminals).toHaveLength(before.roster.terminals.length + 1)
    expect(added.layout.canvas.geometry["02"]!.position).toEqual({ x: 900, y: 500 })
    expect(added.layout.grid.desktop!.map((item) => item.i)).toEqual(["02"])
    expect(added.layout.sizePresets).toEqual({ canvas: { "02": "small" }, grid: { "02": "small" } })
    expect(added.layout).toMatchObject({ hidden: {}, gridMinimized: {}, gridRestoreWidths: {} })
  })

  it("places a terminal added without geometry beside the selected one on Canvas", () => {
    const store = createWorkspaceStore(initial())
    store.dispatch({ type: "terminal/add", target, terminal: terminalFixture(2, "~/project") })
    const { layout } = state(store.getSnapshot())
    expect(layout.canvas.geometry["02"]).toMatchObject({ width: 600, height: 400 })
    expect(layout.canvas.geometry["02"]!.position.x).toBeGreaterThan(0)
    expect(layout.grid).toEqual({})
  })

  it("closing removes every saved reference and ignores delayed layout items", () => {
    const workspace = initial()
    const seeded = state(workspace)
    const canvas = {
      geometry: { "01": { position: { x: 1, y: 1 } } },
      minimized: { "01": true },
    }
    const grid = { desktop: [{ i: "01", x: 0, y: 0, w: 3, h: 4 }] }
    workspace.projects[0]!.history[0]!.state = {
      ...seeded,
      roster: { ...seeded.roster, order: ["01"] },
      layout: {
        canvas,
        grid,
        hidden: { "01": true },
        gridMinimized: { "01": true },
        gridRestoreWidths: { "01": { desktop: 3 } },
        sizePresets: { canvas: { "01": "large" }, grid: { "01": "large" } },
      },
    }
    const closed = workspaceReducer(workspace, { type: "terminal/close", target, terminalId: "01" })
    expect(state(closed)).toEqual({
      ...seeded,
      selected: "",
      roster: { terminals: [], windows: [], order: [] },
      layout: {
        canvas: { geometry: {}, minimized: {} },
        grid: { desktop: [] },
        hidden: {},
        gridMinimized: {},
        gridRestoreWidths: {},
        sizePresets: { canvas: {}, grid: {} },
      },
    })
    const delayed = workspaceReducer(closed, { type: "grid/layouts", target, layouts: grid })
    expect(state(delayed).layout.grid).toEqual({ desktop: [] })
    const delayedCanvas = workspaceReducer(delayed, {
      type: "canvas/layout",
      target,
      layout: canvas,
    })
    expect(state(delayedCanvas).layout.canvas).toEqual({ geometry: {}, minimized: {} })
    const late: WorkspaceAction[] = [
      { type: "terminal/visibility", target, terminalId: "01", hidden: true },
      { type: "terminal/size-preset", target, terminalId: "01", view: "grid", preset: "large" },
      { type: "grid/minimize", target, terminalId: "01" },
    ]
    for (const action of late) expect(workspaceReducer(delayedCanvas, action)).toBe(delayedCanvas)
  })
})

describe("terminal status", () => {
  const statusOf = (workspace: Workspace) => state(workspace).roster.terminals[0]!

  it("replaces the terminal's status and drops details from the previous one", () => {
    const store = createWorkspaceStore(initial())
    store.dispatch({
      type: "terminal/status",
      target,
      terminalId: "01",
      status: { state: "failed", message: "zsh not found" },
    })
    expect(statusOf(store.getSnapshot())).toMatchObject({
      state: "failed",
      message: "zsh not found",
    })
    store.dispatch({
      type: "terminal/status",
      target,
      terminalId: "01",
      status: { state: "exited", exitCode: 2, signal: null },
    })
    expect(statusOf(store.getSnapshot())).toEqual({
      ...terminalFixture(1, "~/project"),
      state: "exited",
      exitCode: 2,
      signal: null,
    })
    store.dispatch({
      type: "terminal/status",
      target,
      terminalId: "01",
      status: { state: "running" },
    })
    expect(statusOf(store.getSnapshot())).toEqual({
      ...terminalFixture(1, "~/project"),
      state: "running",
    })
  })

  it("ignores a status that is already current or names a missing terminal", () => {
    const store = createWorkspaceStore(initial())
    let notifications = 0
    store.subscribe(() => notifications++)
    const exited = { state: "exited", exitCode: null, signal: null } as const
    store.dispatch({ type: "terminal/status", target, terminalId: "01", status: exited })
    const previous = store.getSnapshot()
    store.dispatch({ type: "terminal/status", target, terminalId: "01", status: { ...exited } })
    store.dispatch({
      type: "terminal/status",
      target,
      terminalId: "gone",
      status: { state: "idle" },
    })
    store.dispatch({
      type: "terminal/status",
      target: { ...target, workspaceSessionId: "gone" },
      terminalId: "01",
      status: { state: "idle" },
    })
    expect(store.getSnapshot()).toBe(previous)
    expect(notifications).toBe(1)
  })

  it("keeps only the fields the reported status defines", () => {
    const store = createWorkspaceStore(initial())
    const reported = { state: "running", exitCode: 1, message: "stale", id: "other" }
    store.dispatch({
      type: "terminal/status",
      target,
      terminalId: "01",
      status: reported as TerminalStatus,
    })
    expect(statusOf(store.getSnapshot())).toEqual({
      ...terminalFixture(1, "~/project"),
      state: "running",
    })
  })

  it("treats a new exit code or message as a change", () => {
    const store = createWorkspaceStore(initial())
    store.dispatch({
      type: "terminal/status",
      target,
      terminalId: "01",
      status: { state: "exited", exitCode: 1, signal: null },
    })
    const previous = store.getSnapshot()
    store.dispatch({
      type: "terminal/status",
      target,
      terminalId: "01",
      status: { state: "exited", exitCode: 0, signal: null },
    })
    expect(store.getSnapshot()).not.toBe(previous)
    expect(statusOf(store.getSnapshot())).toMatchObject({ exitCode: 0 })
  })
})

describe("terminal process", () => {
  const terminalOf = (workspace: Workspace) => state(workspace).roster.terminals[0]!

  it("updates what runs in the foreground and keeps the status", () => {
    const store = createWorkspaceStore(initial())
    store.dispatch({
      type: "terminal/process",
      target,
      terminalId: "01",
      process: "claude",
    })
    expect(terminalOf(store.getSnapshot())).toEqual({
      ...terminalFixture(1, "~/project"),
      process: "claude",
    })
  })

  it("ignores an unchanged process or a missing terminal", () => {
    const store = createWorkspaceStore(initial())
    const before = store.getSnapshot()
    store.dispatch({
      type: "terminal/process",
      target,
      terminalId: "01",
      process: terminalOf(before).process,
    })
    store.dispatch({
      type: "terminal/process",
      target,
      terminalId: "gone",
      process: "git",
    })
    expect(store.getSnapshot()).toBe(before)
  })
})

describe("workspace store commits", () => {
  it("refuses a transaction started from inside the commit hook", () => {
    const attempts: unknown[] = []
    const store = createWorkspaceStore(initial(), () => {
      try {
        store.dispatch({ type: "terminal/select", target, terminalId: "" })
      } catch (error) {
        attempts.push(error)
      }
    })
    store.dispatch({ type: "terminal/rename", target, terminalId: "01", name: "Server" })
    expect(attempts).toHaveLength(1)
    expect(state(store.getSnapshot()).selected).toBe("01")
    store.dispatch({ type: "terminal/select", target, terminalId: "" })
    expect(state(store.getSnapshot()).selected).toBe("")
  })
})

describe("workspace store commit failures", () => {
  it("still notifies subscribers when the commit hook throws, then reports the error", () => {
    const store = createWorkspaceStore(initial(), () => {
      // An uncaught refusal of a nested transaction escapes the hook.
      store.dispatch({ type: "terminal/select", target, terminalId: "" })
    })
    const seen: string[] = []
    store.subscribe(() => seen.push(state(store.getSnapshot()).roster.terminals[0]!.name))
    expect(() =>
      store.dispatch({ type: "terminal/rename", target, terminalId: "01", name: "Server" }),
    ).toThrow("cannot start inside a commit")
    expect(seen).toEqual(["Server"])
    expect(state(store.getSnapshot()).roster.terminals[0]!.name).toBe("Server")
  })
})

describe("store", () => {
  it("notifies subscribers after a change and not after one that keeps the value", () => {
    const store = createStore({ count: 0 })
    let notifications = 0
    const unsubscribe = store.subscribe(() => notifications++)
    store.update((value) => value)
    expect(notifications).toBe(0)
    const next = store.update((value) => ({ count: value.count + 1 }))
    expect(next).toEqual({ count: 1 })
    expect(store.getSnapshot()).toBe(next)
    expect(notifications).toBe(1)
    unsubscribe()
    store.update((value) => ({ count: value.count + 1 }))
    expect(notifications).toBe(1)
  })
})
