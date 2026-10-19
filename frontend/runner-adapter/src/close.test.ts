import type { Notice } from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { activeProject, activeSession, workspaceReducer } from "@novadeck/core/state"
import type { WorkspaceAction } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import type { TerminalMessages } from "@novadeck/protocol"
import type { TerminalWatchItem } from "@novadeck/runner-client"
import { noTheme } from "@novadeck/terminal-views/theme"
import { WireError } from "@novadeck/wire"
import type { WireStatus } from "@novadeck/wire/client"
import { afterEach, beforeEach, vi } from "vitest"

import { runnerBackend, type RunnerApi, type RunnerBackendOptions } from "./backend"
import { channel, id as uuid, keptSummary, noCompanions } from "./scripted"
import type { RunnerListing } from "./seed"
import { describe, expect, it } from "./test"

// Every wait here runs on a fake clock, so a slow machine can't push a step past a
// deadline it should beat, or a deadline past a step that should see it run out.
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
// Lets `ms` pass, running the timers due by then and all the work each one wakes.
const elapse = async (ms: number): Promise<void> => void (await vi.advanceTimersByTimeAsync(ms))

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
    await elapse(50)
    commit([{ type: "terminal/close", target, terminalId: terminal.id }])
    await elapse(700)
    runner.reconnect()
    await elapse(1_500)
    expect([...runner.shells]).toEqual([])
    stop()
  })
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
  // Whether its listing fails, as when the link drops right after an answer.
  const listings = { fails: false }
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
      list: async () => {
        if (listings.fails) throw new WireError("DISCONNECTED", "lost")
        return [...held.values()]
      },
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
    // The runner tells its watchers something changed in a terminal it holds.
    report: (terminalId: string) =>
      changes.push({ type: "changed", terminal: held.get(terminalId)! }),
    listings,
  }
}

// The app over the runner: its store, committing to the backend, and the companion's
// reader of the messages, which starts a transaction of its own whenever they change.
const app = (
  runner: ReturnType<typeof holdingRunner>,
  notices: Notice[] = [],
  options: Partial<RunnerBackendOptions> = {},
) => {
  const { backend } = runnerBackend(runner.api, runner.listing, {
    theme: noTheme,
    saveDelay: 10,
    notices: { show: (notice) => void notices.push(notice), onClick: () => () => {} },
    ...options,
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
    await elapse(50)

    expect(() => window.close(runner.ids[0]!)).not.toThrow()
    await elapse(50)

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
    await elapse(50)

    window.close(runner.ids[0]!)
    await elapse(50)

    expect(runner.held()).toContain(runner.ids[0])
    expect(window.roster().toSorted()).toEqual(runner.held().toSorted())
    expect(notices).toEqual([
      {
        id: runner.ids[0],
        title: "Novadeck couldn't close @moth · “Terminal”",
        body: "It's still running, so it stays in its session. The runner broke.",
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
    await elapse(50)
    runner.drop()

    window.close(runner.ids[0]!)
    await elapse(50)
    expect(runner.held()).toContain(runner.ids[0])
    runner.connect()
    await elapse(1500)

    expect(runner.held()).toEqual([runner.ids[1]])
    expect(window.roster()).toEqual(runner.held())
    stop()
  })

  it("is sent again when a stop cut it off and the runner still reports the terminal", async () => {
    const runner = holdingRunner(async () => {})
    const window = app(runner)
    const stop = window.start()
    runner.drop()
    await elapse(50)

    // Waiting for the runner as the window stops, as before a reload or a quit.
    window.close(runner.ids[0]!)
    await elapse(50)
    stop()
    await elapse(1500)
    expect(runner.calls).toEqual([])

    const again = window.start()
    runner.connect()
    await elapse(100)

    expect(runner.held()).toEqual([runner.ids[1]])
    expect(window.roster()).toEqual(runner.held())
    again()
  })

  it("isn't sent again while the first waits for its answer", async () => {
    const runner = holdingRunner(() => new Promise(() => {}))
    const window = app(runner)
    const stop = window.start()
    runner.connect()
    await elapse(50)

    window.close(runner.ids[0]!)
    await elapse(20)
    // The runner still says something of it, as while its close waits on its shell.
    runner.report(runner.ids[0]!)
    await elapse(20)

    expect(runner.calls).toEqual([runner.ids[0]])
    expect(window.roster()).toEqual([runner.ids[1]])
    stop()
  })
})

describe("a close the runner refuses as its link drops", () => {
  it("brings the terminal back with the runner's next report, and says why", async () => {
    const runner = holdingRunner(async () => {
      runner.listings.fails = true
      throw new WireError("INTERNAL_ERROR", "The runner broke.")
    })
    const notices: Notice[] = []
    const window = app(runner, notices)
    const stop = window.start()
    runner.connect()
    await elapse(50)

    window.close(runner.ids[0]!)
    await elapse(50)
    runner.listings.fails = false
    runner.report(runner.ids[0]!)
    await elapse(50)

    expect(window.roster().toSorted()).toEqual(runner.held().toSorted())
    expect(notices.map((notice) => notice.title)).toEqual([
      "Novadeck couldn't close @moth · “Terminal”",
    ])
    stop()
  })
})

describe("a refusal that comes once the window stopped", () => {
  it("says nothing, and the terminal is back once the window starts again", async () => {
    let refuse = (): void => {}
    const runner = holdingRunner(
      () =>
        new Promise((_, reject) => {
          refuse = () => reject(new WireError("INTERNAL_ERROR", "The runner broke."))
        }),
    )
    const notices: Notice[] = []
    const window = app(runner, notices)
    const stop = window.start()
    runner.connect()
    await elapse(50)

    window.close(runner.ids[0]!)
    await elapse(20)
    stop()
    refuse()
    await elapse(50)
    expect(notices).toEqual([])

    const again = window.start()
    await elapse(50)

    expect(window.roster().toSorted()).toEqual(runner.held().toSorted())
    again()
  })
})

describe("a close the runner takes too long to answer", () => {
  it("brings the terminal back saying so, and lets it go once the runner reports it gone", async () => {
    let answer = (): void => {}
    const runner = holdingRunner(() => new Promise<void>((resolve) => (answer = resolve)))
    const notices: Notice[] = []
    const window = app(runner, notices, { closeAnswerMs: 100 })
    const stop = window.start()
    runner.connect()
    await elapse(50)

    window.close(runner.ids[0]!)
    await elapse(400)
    expect(window.roster().toSorted()).toEqual(runner.held().toSorted())
    expect(notices.map((notice) => notice.body)).toEqual([
      "It's still running, so it stays in its session. The runner didn't answer.",
    ])

    runner.removed(runner.ids[0]!)
    await elapse(50)
    expect(window.roster()).toEqual([runner.ids[1]])
    answer()
    await elapse(50)

    expect(runner.held()).toEqual([runner.ids[1]])
    expect(window.roster()).toEqual(runner.held())
    expect(notices).toHaveLength(1)
    stop()
  })

  it("lets the terminal go when the late answer comes without the runner's report", async () => {
    let answer = (): void => {}
    const runner = holdingRunner(() => new Promise<void>((resolve) => (answer = resolve)))
    const notices: Notice[] = []
    const window = app(runner, notices, { closeAnswerMs: 100 })
    const stop = window.start()
    runner.connect()
    await elapse(50)

    window.close(runner.ids[0]!)
    await elapse(400)
    expect(window.roster()).toContain(runner.ids[0])
    answer()
    await elapse(50)
    expect(runner.held()).toEqual([runner.ids[1]])
    expect(window.roster()).toEqual(runner.held())

    // The runner's report that it went, arriving after all, changes nothing more.
    runner.removed(runner.ids[0]!)
    await elapse(50)
    expect(window.roster()).toEqual(runner.held())
    expect(notices).toHaveLength(1)
    stop()
  })

  it("says nothing more when the late answer is a refusal", async () => {
    let refuse = (): void => {}
    const runner = holdingRunner(
      () =>
        new Promise((_, reject) => {
          refuse = () => reject(new WireError("INTERNAL_ERROR", "The runner broke."))
        }),
    )
    const notices: Notice[] = []
    const window = app(runner, notices, { closeAnswerMs: 100 })
    const stop = window.start()
    runner.connect()
    await elapse(50)

    window.close(runner.ids[0]!)
    await elapse(400)
    refuse()
    await elapse(50)

    expect(window.roster().toSorted()).toEqual(runner.held().toSorted())
    expect(notices).toHaveLength(1)
    stop()
  })

  it("leaves a terminal closed again to that newer close, whatever the first one hears", async () => {
    const answers: { resolve: () => void; reject: (error: Error) => void }[] = []
    const runner = holdingRunner(
      () => new Promise<void>((resolve, reject) => void answers.push({ resolve, reject })),
    )
    const notices: Notice[] = []
    const window = app(runner, notices, { closeAnswerMs: 100 })
    const stop = window.start()
    runner.connect()
    await elapse(50)

    window.close(runner.ids[0]!)
    await elapse(400)
    // Back, and closed again by the person.
    window.close(runner.ids[0]!)
    await elapse(20)
    answers[0]!.reject(new WireError("INTERNAL_ERROR", "The runner broke."))
    await elapse(50)
    expect(window.roster()).toEqual([runner.ids[1]])
    expect(notices).toHaveLength(1)

    answers[1]!.resolve()
    await elapse(50)
    expect(runner.held()).toEqual([runner.ids[1]])
    expect(window.roster()).toEqual(runner.held())
    stop()
  })

  it("says nothing once the window stopped", async () => {
    const runner = holdingRunner(() => new Promise(() => {}))
    const notices: Notice[] = []
    const window = app(runner, notices, { closeAnswerMs: 100 })
    const stop = window.start()
    runner.connect()
    await elapse(50)

    window.close(runner.ids[0]!)
    await elapse(20)
    stop()
    runner.listings.fails = true
    await elapse(400)

    expect(notices).toEqual([])
  })
})

describe("a refused close the runner can't list afterwards", () => {
  it("brings the terminal back as the runner last reported it, though it reports nothing more", async () => {
    const runner = holdingRunner(async () => {
      runner.listings.fails = true
      throw new WireError("INTERNAL_ERROR", "The runner broke.")
    })
    const notices: Notice[] = []
    const window = app(runner, notices)
    const stop = window.start()
    runner.connect()
    await elapse(50)

    window.close(runner.ids[0]!)
    await elapse(50)

    expect(window.roster().toSorted()).toEqual(runner.held().toSorted())
    expect(notices).toHaveLength(1)
    stop()
  })

  it("brings the terminal back once the window starts again, when the wait ran out while it was stopped", async () => {
    let answer = (): void => {}
    const runner = holdingRunner(() => new Promise<void>((resolve) => (answer = resolve)))
    const notices: Notice[] = []
    const window = app(runner, notices, { closeAnswerMs: 100 })
    const stop = window.start()
    runner.connect()
    await elapse(50)

    window.close(runner.ids[0]!)
    await elapse(20)
    stop()
    await elapse(400)
    const again = window.start()
    await elapse(50)
    expect(window.roster().toSorted()).toEqual(runner.held().toSorted())
    expect(notices).toEqual([])

    answer()
    await elapse(50)
    expect(window.roster()).toEqual(runner.held())
    again()
  })

  it("runs out however many times the runner asks it to try again", async () => {
    const runner = holdingRunner(async () => {
      throw new WireError("CLOSING", "Restarting.")
    })
    const notices: Notice[] = []
    const window = app(runner, notices, { closeAnswerMs: 100 })
    const stop = window.start()
    runner.connect()
    await elapse(50)

    window.close(runner.ids[0]!)
    await elapse(400)

    expect(window.roster().toSorted()).toEqual(runner.held().toSorted())
    expect(notices).toHaveLength(1)
    stop()
  })
})
