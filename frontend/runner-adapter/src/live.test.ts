import type { BackendAction } from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { createTerminalState, workspaceReducer, type WorkspaceAction } from "@novadeck/core/state"
import type { Workspace } from "@novadeck/core/types"
import { noTheme } from "@novadeck/terminal-views/theme"
import { afterAll, vi } from "vitest"

import { runnerBackend, type RunnerApi } from "./backend"
import type { RunnerListing } from "./sessions/seed"
import { describe, expect, it } from "./test"
import { recordingRunner, startTestRunner } from "./testing/runner"

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
  const project = (id: string) => workspace.projects.find((each) => each.id === id)
  return { backend, commit, stop, received, project, workspace: () => workspace }
}

const session = (name: string) => ({
  id: crypto.randomUUID(),
  name,
  visitedAt: Date.now(),
  state: createTerminalState([], "grid", "grid"),
})

// The writes a window made to projects, sessions and terminals, as its link records them.
const writes = (io: readonly string[]) =>
  io.filter((entry) => /^(create|arrange|remove|rename|close)/u.test(entry))

describe("projects and sessions another window changes", () => {
  it("shows each window what the other made, arranged and removed, and writes none of it back", async () => {
    const io: string[] = []
    const first = openWindow(runner.listing, runner.client)
    const home = { id: crypto.randomUUID(), name: "Shared", directory: process.cwd() }
    const opened = session("First")
    first.commit([{ type: "project/add", project: home, activate: true, initialSession: opened }])
    await vi.waitFor(
      async () =>
        expect((await runner.reload()).some(({ project }) => project.id === home.id)).toBe(true),
      eventually,
    )
    const second = openWindow(await runner.reload(), recordingRunner(await runner.another(), io))
    await vi.waitFor(() => expect(second.project(home.id)).toBeDefined(), eventually)
    io.length = 0
    const shown = () => second.project(home.id)!.activeSessionId
    const listed = () => second.project(home.id)!.history.map(({ id }) => id)

    // A session made there joins this window's list, unopened.
    const made = session("Made there")
    first.commit([{ type: "session/add", projectId: home.id, session: made }])
    await vi.waitFor(() => expect(listed()).toContain(made.id), eventually)
    expect(shown()).toBe(opened.id)

    // Arranged there: the order here follows.
    first.commit([
      { type: "session/move", projectId: home.id, workspaceSessionId: opened.id, index: 0 },
    ])
    await vi.waitFor(() => expect(listed()).toEqual([opened.id, made.id]), eventually)

    // Removed there, a terminal running in it: gone here, its terminal closed by the runner
    // alone.
    const target = { projectId: home.id, workspaceSessionId: made.id }
    const terminal = first.backend.newTerminal({ target, directory: home.directory })
    first.commit([{ type: "terminal/add", target, terminal }])
    await vi.waitFor(
      () =>
        expect(
          second
            .project(home.id)!
            .history.find(({ id }) => id === made.id)
            ?.state.roster.terminals.map(({ id }) => id),
        ).toEqual([terminal.id]),
      eventually,
    )
    first.commit([
      { type: "session/remove", projectId: home.id, workspaceSessionId: made.id, now: Date.now() },
    ])
    await vi.waitFor(() => expect(listed()).toEqual([opened.id]), eventually)

    // A project made there joins this window's, read as the runner holds it.
    const other = { id: crypto.randomUUID(), name: "Made there too", directory: process.cwd() }
    first.commit([{ type: "project/add", project: other, initialSession: session("Its own") }])
    await vi.waitFor(() => expect(second.project(other.id)?.history).toHaveLength(1), eventually)

    // Arranged and pinned there: told here as the runner keeps it.
    const arrangements: { order: readonly string[]; pinned: readonly string[] }[] = []
    const stopHearing = second.backend.arranged!((arrangement) => arrangements.push(arrangement))
    await first.backend.arrange!({ order: [other.id, home.id], pinned: [other.id] })
    await vi.waitFor(
      () =>
        expect(arrangements.at(-1)).toMatchObject({
          order: expect.arrayContaining([other.id, home.id]),
          pinned: [other.id],
        }),
      eventually,
    )
    stopHearing()

    // Removed there: gone here.
    first.commit([{ type: "project/remove", projectId: other.id, now: Date.now() }])
    await vi.waitFor(() => expect(second.project(other.id)).toBeUndefined(), eventually)

    // What this window learned it never sent back.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(writes(io)).toEqual([])
    second.stop()
    first.commit([{ type: "project/remove", projectId: home.id, now: Date.now() }])
    first.stop()
  })
})
