import type { Notice } from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { activeProject, activeSession, workspaceReducer } from "@novadeck/core/state"
import type { WorkspaceAction } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import type { TerminalMessages } from "@novadeck/protocol"
import type { TerminalWatchItem } from "@novadeck/runner-client"
import { noTheme } from "@novadeck/terminal-views/theme"
import { pause } from "@novadeck/terminal/view"
import { WireError } from "@novadeck/wire"
import type { WireStatus } from "@novadeck/wire/client"

import { runnerBackend, type RunnerApi } from "./backend"
import { channel, id as uuid, keptSummary, noCompanions } from "./scripted"
import type { RunnerListing } from "./seed"
import { describe, expect, it } from "./test"

// A terminal watch that never reports anything.
const nothing = (): AsyncIterableIterator<never, undefined> => {
  const iterator: AsyncIterableIterator<never, undefined> = {
    [Symbol.asyncIterator]: () => iterator,
    next: () => new Promise(() => {}),
    return: async () => ({ done: true, value: undefined }),
  }
  return iterator
}

// A runner whose link drops right after it started a shell, before it could answer:
// a situation a real runner cannot be put in on cue.
const droppingRunner = () => {
  let status: WireStatus = { state: "connected", epoch: "r1" }
  const wake = new Set<() => void>()
  const set = (next: WireStatus): void => {
    status = next
    for (const resolve of wake) resolve()
    wake.clear()
  }
  const statuses = async function* (): AsyncGenerator<WireStatus, undefined> {
    let last: WireStatus | undefined
    for (;;) {
      if (status !== last) {
        last = status
        yield status
      }
      // eslint-disable-next-line no-await-in-loop -- Waits for the next change.
      await new Promise<void>((resolve) => wake.add(resolve))
    }
  }
  const shells = new Set<string>()
  const api = {
    watch: statuses,
    projects: { list: async () => [], create: async () => ({}), rename: async () => ({}) },
    sessions: {
      list: async () => [],
      create: async () => ({}),
      rename: async () => ({}),
      save: async () => {},
    },
    terminals: {
      list: async () => [],
      watch: nothing,
      requests: nothing,
      create: async (input: { readonly id: string }) => {
        if (shells.has(input.id)) throw new WireError("CONFLICT", "taken")
        shells.add(input.id)
        set({ state: "reconnecting", error: new WireError("DISCONNECTED") })
        throw new WireError("DISCONNECTED", "lost")
      },
      close: async (id: string) => void shells.delete(id),
      restart: async () => {
        throw new Error("not used here")
      },
      attach: () => new Promise(() => {}),
    },
    companions: noCompanions,
  } as unknown as RunnerApi
  return { api, shells, reconnect: () => set({ state: "connected", epoch: "r1" }) }
}

describe("closing a terminal while its create is unanswered", () => {
  it("still ends the shell the runner started", async () => {
    const runner = droppingRunner()
    const listing: RunnerListing = [
      {
        project: { id: "p", name: "P", cwd: "/tmp" },
        sessions: [{ session: { id: "s", projectId: "p", name: "S", state: null }, terminals: [] }],
      },
    ]
    const { backend } = runnerBackend(runner.api, listing, { theme: noTheme, saveDelay: 10 })
    let workspace = workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 1 })
    backend.commit(workspace, [])
    const stop = backend.start!({ dispatch: () => {}, open: () => {} })
    const commit = (actions: WorkspaceAction[]): void => {
      workspace = actions.reduce(workspaceReducer, workspace)
      backend.commit(workspace, actions)
    }
    const target = {
      projectId: activeProject(workspace)!.id,
      workspaceSessionId: activeSession(workspace)!.id,
    }
    const terminal = backend.newTerminal({ target, directory: "/tmp" })
    commit([{ type: "terminal/add", target, terminal }])
    await pause(50)
    commit([{ type: "terminal/close", target, terminalId: terminal.id }])
    await pause(700)
    runner.reconnect()
    await pause(1_500)
    expect([...runner.shells]).toEqual([])
    stop()
  }, 10_000)
})

// A runner holding two running terminals whose agents have a thread together, whose
// close the test decides, and whose link the test can drop. It lists what it still holds.
const holdingRunner = (close: (id: string) => Promise<void>) => {
  const ids = [uuid(1), uuid(2)]
  const handles = ["moth", "fox"]
  const held = new Map(
    ids.map((terminalId, index) => [
      terminalId,
      keptSummary(terminalId, "s", { started: true, run: 1, handle: handles[index]! }),
    ]),
  )
  // Each watch of the link starts from its latest status, as the client's does.
  let status: WireStatus = { state: "reconnecting", error: new WireError("DISCONNECTED") }
  const wake = new Set<() => void>()
  const set = (next: WireStatus): void => {
    status = next
    for (const resolve of wake) resolve()
    wake.clear()
  }
  const statuses = async function* (): AsyncGenerator<WireStatus, undefined> {
    let last: WireStatus | undefined
    for (;;) {
      if (status !== last) {
        last = status
        yield status
      }
      // eslint-disable-next-line no-await-in-loop -- Waits for the next change.
      await new Promise<void>((resolve) => wake.add(resolve))
    }
  }
  let changes = channel<TerminalWatchItem>()
  const calls: string[] = []
  const api = {
    watch: statuses,
    projects: { list: async () => [], create: async () => ({}), rename: async () => ({}) },
    sessions: {
      list: async () => [],
      create: async () => ({}),
      rename: async () => ({}),
      save: async () => {},
    },
    terminals: {
      list: async () => [...held.values()],
      // A fresh watch for every start, which lists what the runner holds.
      watch: () => {
        changes = channel<TerminalWatchItem>()
        for (const terminal of held.values()) changes.push({ type: "changed", terminal })
        return changes.iterator
      },
      requests: () => channel<never>().iterator,
      close: async (terminalId: string) => {
        if (status.state !== "connected") throw new WireError("DISCONNECTED", "lost")
        calls.push(terminalId)
        await close(terminalId)
        held.delete(terminalId)
      },
      attach: () => new Promise(() => {}),
    },
    messages: {
      watch: (terminalId: string) => {
        const listing = channel<TerminalMessages>()
        const index = ids.indexOf(terminalId)
        listing.push({
          terminalId,
          handle: handles[index]!,
          delivery: "ready",
          waits: null,
          paused: false,
          threads: [
            {
              id: "th",
              peer: handles[1 - index]!,
              hops: 1,
              allowed: 4,
              held: false,
              stopped: false,
              messages: [],
            },
          ],
        })
        return listing.iterator
      },
    },
    companions: noCompanions,
  } as unknown as RunnerApi
  const listing: RunnerListing = [
    {
      project: { id: "p", name: "P", cwd: "/tmp" },
      sessions: [
        {
          session: { id: "s", projectId: "p", name: "S", state: null },
          terminals: [...held.values()],
        },
      ],
    },
  ]
  return {
    api,
    listing,
    ids,
    calls,
    held: () => [...held.keys()],
    connect: () => set({ state: "connected", epoch: "r1" }),
    drop: () => set({ state: "reconnecting", error: new WireError("DISCONNECTED") }),
    // The runner tells its watchers the terminal is gone, as its close does at once.
    removed: (terminalId: string) => changes.push({ type: "removed", terminalId, sessionId: "s" }),
  }
}

// The app over the runner: its store, committing to the backend, and the companion's
// reader of the messages, which starts a transaction of its own whenever they change.
const app = (runner: ReturnType<typeof holdingRunner>, notices: Notice[] = []) => {
  const { backend } = runnerBackend(runner.api, runner.listing, {
    theme: noTheme,
    saveDelay: 10,
    notices: { show: (notice) => void notices.push(notice), onClick: () => () => {} },
  })
  const initial = workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 1 })
  const workspace = createWorkspaceStore(initial, backend.commit)
  backend.commit(initial, [])
  const start = () =>
    backend.start!({ dispatch: (actions) => void workspace.transact(actions), open: () => {} })
  const target = () => ({
    projectId: activeProject(workspace.getSnapshot())!.id,
    workspaceSessionId: activeSession(workspace.getSnapshot())!.id,
  })
  backend.messages!.state.subscribe(() =>
    workspace.transact([{ type: "terminal/select", target: target(), terminalId: runner.ids[1]! }]),
  )
  return {
    start,
    close: (terminalId: string) =>
      workspace.dispatch({ type: "terminal/close", target: target(), terminalId }),
    roster: () =>
      activeSession(workspace.getSnapshot())!.state.roster.terminals.map((each) => each.id),
  }
}

describe("closing a terminal whose agent has messages", () => {
  it("reaches the runner, whatever reads the messages as the close commits", async () => {
    const runner = holdingRunner(async () => {})
    const window = app(runner)
    const stop = window.start()
    runner.connect()
    await pause(50)

    expect(() => window.close(runner.ids[0]!)).not.toThrow()
    await pause(50)

    expect(runner.calls).toEqual([runner.ids[0]])
    expect(window.roster()).toEqual(runner.held())
    stop()
  })
})

describe("a close the runner refuses", () => {
  it("brings the terminal back to its session and tells the person why", async () => {
    const runner = holdingRunner(async () => {
      throw new WireError("INTERNAL_ERROR", "The runner broke.")
    })
    const notices: Notice[] = []
    const window = app(runner, notices)
    const stop = window.start()
    runner.connect()
    await pause(50)

    window.close(runner.ids[0]!)
    await pause(50)

    expect(runner.held()).toContain(runner.ids[0])
    expect(window.roster().toSorted()).toEqual(runner.held().toSorted())
    expect(notices).toEqual([
      {
        id: runner.ids[0],
        title: "Novadeck couldn't close @moth · “Terminal”",
        body: "It's still running, so it's back in its session. The runner broke.",
      },
    ])
    stop()
  })
})

describe("a close the runner doesn't answer", () => {
  it("lands once the runner is back, and the window and the runner agree", async () => {
    const runner = holdingRunner(async () => {})
    const window = app(runner)
    const stop = window.start()
    runner.connect()
    await pause(50)
    runner.drop()

    window.close(runner.ids[0]!)
    await pause(50)
    expect(runner.held()).toContain(runner.ids[0])
    runner.connect()
    await pause(700)

    expect(runner.held()).toEqual([runner.ids[1]])
    expect(window.roster()).toEqual(runner.held())
    stop()
  })

  it("is sent again when a stop cut it off and the runner still reports the terminal", async () => {
    const runner = holdingRunner(async () => {})
    const window = app(runner)
    const stop = window.start()
    runner.drop()
    await pause(50)

    // Waiting for the runner as the window stops, as before a reload or a quit.
    window.close(runner.ids[0]!)
    await pause(50)
    stop()
    await pause(600)
    expect(runner.calls).toEqual([])

    const again = window.start()
    runner.connect()
    await pause(100)

    expect(runner.held()).toEqual([runner.ids[1]])
    expect(window.roster()).toEqual(runner.held())
    again()
  })

  it("is left alone once the runner reports the terminal gone", async () => {
    const runner = holdingRunner(() => new Promise(() => {}))
    const window = app(runner)
    const stop = window.start()
    runner.connect()
    await pause(50)

    window.close(runner.ids[0]!)
    await pause(20)
    runner.removed(runner.ids[0]!)
    await pause(20)

    expect(runner.calls).toEqual([runner.ids[0]])
    expect(window.roster()).toEqual([runner.ids[1]])
    stop()
  })
})
