import { RunnerError, type Runner, type RunnerStatus } from "@novadeck/protocol/client"
import { vi } from "vitest"

import { workspaceFromSeed } from "../../model/seed"
import { activeSession, createTerminalState } from "../../model/state"
import { createWorkspaceStore } from "../../model/store"
import { describe, expect, it } from "../../test"
import type { BackendAction } from "../port"
import { runnerBackend, type RunnerApi } from "./backend"
import { keptSummary } from "./scripted"
import { startingTerminal, type RunnerListing } from "./seed"
import { encodeSession } from "./session-state"

const unused = (): never => {
  throw new Error("not used here")
}
// A terminal watch that never reports anything.
const nothing = (): AsyncIterableIterator<never, undefined> => {
  const iterator: AsyncIterableIterator<never, undefined> = {
    [Symbol.asyncIterator]: () => iterator,
    next: () => new Promise(() => {}),
    return: async () => ({ done: true, value: undefined }),
  }
  return iterator
}

// A runner that dies each time it is asked to start a shell, coming back as a new
// process: something a real runner cannot be made to do on cue.
const crashingRunner = () => {
  let generation = 1
  let creates = 0
  const wake = new Set<() => void>()
  const statuses = async function* (): AsyncGenerator<RunnerStatus, undefined> {
    let seen = 0
    for (;;) {
      if (seen !== generation) {
        seen = generation
        yield { state: "connected", runnerId: `runner-${generation}` }
      }
      // eslint-disable-next-line no-await-in-loop -- Waits for the next crash.
      await new Promise<void>((resolve) => wake.add(resolve))
    }
  }

  let healed = false
  const crash = async (input: { readonly id?: string }): Promise<unknown> => {
    creates += 1
    if (healed)
      return {
        id: input.id,
        sessionId: "s",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        run: 1,
        exit: null,
        process: { name: "zsh", argv: null },
      }
    generation += 1
    for (const resolve of wake) resolve()
    wake.clear()
    throw new RunnerError("DISCONNECTED", "The runner crashed.")
  }
  const api = {
    watch: statuses,
    projects: { list: unused, create: unused, rename: unused, remove: unused },
    sessions: { list: unused, create: unused, rename: unused, save: async () => {} },
    terminals: {
      list: unused,
      watch: nothing,
      requests: nothing,
      create: crash,
      restart: crash,
      close: async () => {},
      attach: () => Promise.reject(new RunnerError("DISCONNECTED")),
    },
  } as unknown as RunnerApi satisfies Pick<Runner, "watch">
  return {
    api,
    creates: () => creates,
    // The runner stops crashing from now on.
    heal: () => {
      healed = true
    },
  }
}

// A backend on screen over the crashing runner, with one saved terminal to restore.
const openCrashing = () => {
  const runner = crashingRunner()
  const terminal = startingTerminal("00000000-0000-4000-8000-000000000001", "/tmp")
  const session = {
    id: "s",
    name: "S",
    visitedAt: 5,
    state: createTerminalState([terminal], "grid", "grid"),
  }
  const listing: RunnerListing = [
    {
      project: { id: "p", name: "P", cwd: "/tmp" },
      sessions: [
        {
          session: { id: "s", projectId: "p", name: "S", state: encodeSession(session, 2) },
          terminals: [keptSummary(terminal.id, "s")],
        },
      ],
    },
  ]
  const created = runnerBackend(runner.api, listing, { saveDelay: 10 })
  created.backend.commit(
    workspaceFromSeed(created.backend.seed, { view: "grid", windowedView: "grid", now: 1 }),
    [],
  )
  const received: BackendAction[] = []
  const stop = created.backend.start!({
    dispatch: (actions) => received.push(...actions),
    open: () => {},
  })
  const tripped = () =>
    vi.waitFor(
      () =>
        expect(received.at(-1)).toMatchObject({
          type: "terminal/status",
          status: { state: "failed", message: "Runner keeps crashing" },
        }),
      { timeout: 5_000 },
    )
  return { ...runner, ...created, received, stop, tripped }
}

describe("a runner that crashes while shells start", () => {
  it("gives up after a few restarts and leaves the terminal waiting for Enter", async () => {
    const app = openCrashing()
    await app.tripped()
    expect(app.creates()).toBeLessThanOrEqual(5)
    // The footer and the dialog hear of it too, with the count.
    expect(app.backend.crashLoop?.crashes.getSnapshot()).toBeGreaterThan(3)
    app.stop()
  })

  it("starts over when asked to try again", async () => {
    const app = openCrashing()
    await app.tripped()
    const before = app.creates()
    app.heal()
    app.backend.crashLoop!.retry()
    expect(app.backend.crashLoop?.crashes.getSnapshot()).toBe(0)
    await app.idle()
    expect(app.creates()).toBe(before + 1)
    expect(app.received.at(-1)).toMatchObject({
      type: "terminal/status",
      status: { state: "starting" },
    })
    app.stop()
  })
})

// A saved session in project "p" holding one terminal that waits for a shell.
const saved = (id: string, terminalId: string, visitedAt: number, rank: number) => ({
  session: {
    id,
    projectId: "p",
    name: id,
    state: encodeSession(
      {
        id,
        name: id,
        visitedAt,
        state: createTerminalState([startingTerminal(terminalId, "/tmp")], "grid", "grid"),
      },
      rank,
    ),
  },
  terminals: [keptSummary(terminalId, id)],
})

// The crashing runner behind a real workspace store, with a second session whose saved
// terminal is waiting for a shell.
const openInStore = () => {
  const runner = crashingRunner()
  const listing: RunnerListing = [
    {
      project: { id: "p", name: "P", cwd: "/tmp" },
      sessions: [
        saved("s", "00000000-0000-4000-8000-000000000001", 5, 2),
        saved("s2", "00000000-0000-4000-8000-000000000002", 1, 0),
      ],
    },
  ]
  const created = runnerBackend(runner.api, listing, { saveDelay: 10 })
  const initial = workspaceFromSeed(created.backend.seed, {
    view: "grid",
    windowedView: "grid",
    now: 1,
  })
  const store = createWorkspaceStore(initial, created.backend.commit)
  created.backend.commit(initial, [])
  // What the app's connection does: each report commits to the store.
  const stop = created.backend.start!({
    dispatch: (actions) => void store.transact(actions),
    open: () => {},
  })
  const statusIn = (sessionId: string) =>
    store.getSnapshot().projects[0]!.history.find((session) => session.id === sessionId)!.state
      .roster.terminals[0]
  return { ...runner, ...created, store, stop, statusIn }
}

describe("a crash loop behind the workspace store", () => {
  it("lets the person switch sessions, and says why their terminals wait", async () => {
    const app = openInStore()
    expect(activeSession(app.store.getSnapshot())!.id).toBe("s")
    await vi.waitFor(
      () => expect(app.backend.crashLoop!.crashes.getSnapshot()).toBeGreaterThan(3),
      {
        timeout: 8_000,
      },
    )
    expect(() =>
      app.store.dispatch({
        type: "session/select",
        projectId: "p",
        workspaceSessionId: "s2",
        now: 10,
      }),
    ).not.toThrow()
    await vi.waitFor(() =>
      expect(app.statusIn("s2")).toMatchObject({
        state: "failed",
        message: "Runner keeps crashing",
      }),
    )
    // Try again from the first session: the second one's terminal waits for its
    // session again instead of keeping the crash-loop label.
    app.store.dispatch({ type: "session/select", projectId: "p", workspaceSessionId: "s", now: 20 })
    app.backend.crashLoop!.retry()
    await vi.waitFor(() => expect(app.statusIn("s2")?.state).toBe("starting"))
    app.stop()
  }, 15_000)

  it("stops creating a new terminal into the crash loop", async () => {
    const app = openInStore()
    await vi.waitFor(
      () => expect(app.backend.crashLoop!.crashes.getSnapshot()).toBeGreaterThan(3),
      {
        timeout: 8_000,
      },
    )
    const workspace = app.store.getSnapshot()
    const target = { projectId: "p", workspaceSessionId: activeSession(workspace)!.id }
    const terminal = app.backend.newTerminal({ target, directory: "/tmp" })
    app.store.dispatch({ type: "terminal/add", target, terminal })
    const before = app.creates()
    await vi.waitFor(
      () =>
        expect(
          app.store
            .getSnapshot()
            .projects[0]!.history.find((session) => session.id === target.workspaceSessionId)!
            .state.roster.terminals.find((item) => item.id === terminal.id),
        ).toMatchObject({ state: "failed", message: "Runner keeps crashing" }),
      { timeout: 5_000 },
    )
    expect(app.creates() - before).toBeLessThanOrEqual(2)
    app.stop()
  }, 15_000)
})
