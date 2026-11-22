import type { BackendAction } from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { createTerminalState, workspaceReducer, type WorkspaceAction } from "@novadeck/core/state"
import type { CanvasLayout, Workspace, WorkspaceTarget } from "@novadeck/core/types"
import type { Runner } from "@novadeck/runner-client"
import { noTheme } from "@novadeck/terminal-views/theme"
import { afterAll, vi } from "vitest"

import { runnerBackend, type RunnerApi } from "./backend"
import type { RunnerListing } from "./sessions/seed"
import { decodeSession } from "./sessions/state"
import { describe, expect, it } from "./test"
import { startTestRunner } from "./testing/runner"

// Real shells start in each window's session, slower while other files' shells run.
const eventually = { timeout: 10_000 }
vi.setConfig({ testTimeout: 30_000 })

const runner = await startTestRunner()
afterAll(() => runner.close())

// A window of the app over its own link to the runner: what its backend dispatches is laid in
// and committed back, as the app's store does.
const openWindow = (listing: RunnerListing, api: RunnerApi) => {
  const { backend } = runnerBackend(api, listing, { saveDelay: 10, theme: noTheme })
  let workspace = workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 1 })
  backend.commit(workspace, [])
  const received: BackendAction[] = []
  const commit = (actions: readonly WorkspaceAction[]): Workspace => {
    workspace = actions.reduce(workspaceReducer, workspace)
    backend.commit(workspace, actions)
    return workspace
  }
  const stop = backend.start!({
    dispatch: (actions) => {
      received.push(...actions)
      commit(actions)
    },
    open: () => {},
  })
  const stateOf = (target: WorkspaceTarget) =>
    workspace.projects
      .find((project) => project.id === target.projectId)!
      .history.find((session) => session.id === target.workspaceSessionId)!.state
  return { backend, commit, stop, received, stateOf, workspace: () => workspace }
}

const at = (x: number) => ({ position: { x, y: 0 }, width: 400, height: 300 })
const moved =
  (id: string, x: number) =>
  (layout: CanvasLayout): CanvasLayout => ({
    geometry: { ...layout.geometry, [id]: at(x) },
  })

// What the runner holds of the session's canvas, as a load reads it.
const heldGeometry = async (target: WorkspaceTarget) => {
  const listed = await runner.client.sessions.list({ projectId: target.projectId })
  const state = listed.find((each) => each.id === target.workspaceSessionId)?.state ?? null
  return decodeSession(state)?.state.layout.canvas.geometry
}

// Two windows on one session with two terminals, both on the runner.
const sharedSession = async () => {
  const first = openWindow(runner.listing, runner.client)
  const project = { id: crypto.randomUUID(), name: "tmp", directory: process.cwd() }
  const session = {
    id: crypto.randomUUID(),
    name: "First",
    visitedAt: Date.now(),
    state: createTerminalState([], "canvas", "canvas"),
  }
  first.commit([{ type: "project/add", project, activate: true, initialSession: session }])
  const target = { projectId: project.id, workspaceSessionId: session.id }
  const [one, two] = [0, 1].map(() => {
    const terminal = first.backend.newTerminal({ target, directory: project.directory })
    first.commit([{ type: "terminal/add", target, terminal }])
    return terminal.id
  }) as [string, string]
  first.commit([
    {
      type: "canvas/layout",
      target,
      layout: { geometry: { [one]: at(0), [two]: at(500) } },
    },
  ])
  await vi.waitFor(
    async () => expect(Object.keys((await heldGeometry(target)) ?? {})).toHaveLength(2),
    eventually,
  )
  const other: Runner = await runner.another()
  const second = openWindow(await runner.reload(), other)
  await vi.waitFor(
    () => expect(second.stateOf(target).roster.terminals).toHaveLength(2),
    eventually,
  )
  const close = () => {
    second.stop()
    first.commit([{ type: "project/remove", projectId: project.id, now: Date.now() }])
    first.stop()
  }
  return { first, second, target, one, two, close }
}

describe("a session two windows share", () => {
  it("shows each window the other's change as it lands", async () => {
    const { first, second, target, one, close } = await sharedSession()
    first.commit([{ type: "canvas/layout", target, layout: moved(one, 40) }])
    await vi.waitFor(
      () => expect(second.stateOf(target).layout.canvas.geometry[one]).toEqual(at(40)),
      eventually,
    )
    // Its own change coming back changes nothing in the window that made it.
    expect(first.received.filter((action) => action.type === "session/shared")).toEqual([])
    close()
  })

  // Both change the session before either's change lands, a different terminal each: every
  // window, and the runner, end with both changes.
  it("keeps both windows' changes when they cross", async () => {
    const { first, second, target, one, two, close } = await sharedSession()
    first.commit([{ type: "canvas/layout", target, layout: moved(one, 40) }])
    second.commit([{ type: "canvas/layout", target, layout: moved(two, 900) }])
    first.commit([{ type: "canvas/layout", target, layout: moved(one, 60) }])
    const both = { [one]: at(60), [two]: at(900) }
    await vi.waitFor(async () => {
      expect(first.stateOf(target).layout.canvas.geometry).toEqual(both)
      expect(second.stateOf(target).layout.canvas.geometry).toEqual(both)
      expect(await heldGeometry(target)).toEqual(both)
    }, eventually)
    close()
  })

  it("keeps where each window looks its own", async () => {
    const { first, second, target, two, close } = await sharedSession()
    second.commit([
      { type: "view/change", target, view: "grid", enabledViews: ["focus", "grid", "canvas"] },
    ])
    second.commit([{ type: "terminal/select", target, terminalId: two }])
    second.commit([{ type: "canvas/layout", target, layout: moved(two, 700) }])
    await vi.waitFor(
      () => expect(first.stateOf(target).layout.canvas.geometry[two]).toEqual(at(700)),
      eventually,
    )
    expect(first.stateOf(target).view).toBe("canvas")
    close()
  })

  it("shows a rename in the other window, which never writes it back", async () => {
    const { first, second, target, close } = await sharedSession()
    const revision = async () =>
      (await runner.client.sessions.list({ projectId: target.projectId })).find(
        (each) => each.id === target.workspaceSessionId,
      )!.revision!
    const before = await revision()
    second.commit([
      {
        type: "session/rename",
        projectId: target.projectId,
        workspaceSessionId: target.workspaceSessionId,
        name: "Shared by two",
      },
    ])
    await vi.waitFor(() => {
      const session = first
        .workspace()
        .projects.find((project) => project.id === target.projectId)!
        .history.find((each) => each.id === target.workspaceSessionId)!
      expect(session.name).toBe("Shared by two")
    }, eventually)
    // The rename alone raised it: the window that only showed it wrote nothing back.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await revision()).toBe(before + 1)
    close()
  })
})
