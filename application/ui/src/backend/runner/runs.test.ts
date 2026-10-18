import type { TerminalSummary } from "@novadeck/protocol"
import { type TerminalWatchItem } from "@novadeck/runner-client"
import { WireError } from "@novadeck/wire"
import type { WireStatus } from "@novadeck/wire/client"
import { afterAll, vi } from "vitest"

import type { BackendAction } from "#core/port"
import { workspaceFromSeed } from "#core/seed"
import { activeSession, createTerminalState, workspaceReducer } from "#core/state"
import type { Workspace } from "#core/types"

import { context, describe, expect, it } from "../../test"
import { noTheme } from "../terminal-views/theme"
import { runnerBackend, type RunnerApi } from "./backend"
import { noCompanions } from "./scripted"
import { startingTerminal, type RunnerListing } from "./seed"
import { encodeSession } from "./session-state"
import { startTestRunner } from "./testing"

// Values pushed by the test, read by the adapter as a stream.
const channel = <T>() => {
  const queued: T[] = []
  let wake: (() => void) | undefined
  const iterator: AsyncIterableIterator<T, undefined> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      // eslint-disable-next-line no-await-in-loop -- Waits for the next pushed value.
      while (!queued.length) await new Promise<void>((resolve) => (wake = resolve))
      return { value: queued.shift()!, done: false }
    },
    return: async () => ({ value: undefined, done: true }),
  }
  return {
    iterator,
    push: (value: T) => {
      queued.push(value)
      wake?.()
    },
  }
}

const unused = (): never => {
  throw new Error("not used here")
}

const terminalId = "00000000-0000-4000-8000-000000000001"
const summary = (change: Partial<TerminalSummary>): TerminalSummary => ({
  id: terminalId,
  sessionId: "s",
  title: "Terminal",
  titleSource: { kind: "default" },
  handle: "moth",
  ledBy: null,
  openedBy: null,
  agentRan: false,
  started: true,
  command: null,
  lastProgram: null,
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  run: 1,
  exit: null,
  process: { name: "zsh", argv: null },
  agent: null,
  ready: null,
  activity: null,
  telemetry: null,
  ...change,
})

// A runner the test drives step by step: what its watches report, and when a restart
// answers. Timing like this cannot be arranged with a real runner.
// `lastProgram` is the program the runner last saw there, to restore.
const scripted = (reported: TerminalSummary, lastProgram = "") => {
  const listed = lastProgram ? { ...reported, lastProgram } : reported
  const changes = channel<TerminalWatchItem>()
  const statuses = channel<WireStatus>()
  const restarts: ((summary: TerminalSummary) => void)[] = []
  const api = {
    watch: () => statuses.iterator,
    projects: { list: unused, create: unused, rename: unused, remove: unused },
    sessions: { list: unused, create: unused, rename: unused, save: async () => {} },
    terminals: {
      list: unused,
      watch: () => changes.iterator,
      requests: () => channel<never>().iterator,
      // Never answers: a fresh shell stays starting.
      create: () => new Promise(() => {}),
      close: async () => {},
      restart: () => new Promise<TerminalSummary>((resolve) => restarts.push(resolve)),
      attach: () => new Promise(() => {}),
    },
    companions: noCompanions,
  } as unknown as RunnerApi
  const session = {
    id: "s",
    name: "S",
    visitedAt: 5,
    state: createTerminalState([startingTerminal(terminalId, "/tmp")], "grid", "grid"),
  }
  const listing: RunnerListing = [
    {
      project: { id: "p", name: "P", cwd: "/tmp" },
      sessions: [
        {
          session: { id: "s", projectId: "p", name: "S", state: encodeSession(session, 2) },
          terminals: [listed],
        },
      ],
    },
  ]
  const created = runnerBackend(api, listing, { theme: noTheme, saveDelay: 10 })
  created.backend.commit(
    workspaceFromSeed(created.backend.seed, { view: "grid", windowedView: "grid", now: 1 }),
    [],
  )
  const received: BackendAction[] = []
  const stop = created.backend.start!({
    dispatch: (actions) => received.push(...actions),
    open: () => {},
  })
  statuses.push({ state: "connected", epoch: "runner-1" })
  const statusesOf = () =>
    received.flatMap((action) => (action.type === "terminal/status" ? [action.status] : []))
  const key = { projectId: "p", workspaceSessionId: "s", terminalId }
  return { ...created, changes, statuses, restarts, received, statusesOf, stop, key }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

// The terminal once the store applied every action the adapter sent: its state, and the
// program waiting to be restored.
const restoreOf = (app: ReturnType<typeof scripted>) => {
  const seeded = workspaceFromSeed(app.backend.seed, { view: "grid", windowedView: "grid", now: 1 })
  const session = activeSession(app.received.reduce<Workspace>(workspaceReducer, seeded))!
  const terminal = session.state.roster.terminals[0]!
  return { state: terminal.state, restored: terminal.restoredProcess }
}

describe("a terminal the runner loses", () => {
  it("keeps the program it was running to restore in the fresh shell", async () => {
    const app = scripted(summary({ process: { name: "claude", argv: null } }))
    await flush()
    // A new runner reports its terminals, and this one is not among them.
    app.statuses.push({ state: "connected", epoch: "runner-2" })
    app.changes.push({ type: "reset" })
    app.changes.push({ type: "synced" })
    await vi.waitFor(() => expect(app.statusesOf().at(-1)).toEqual({ state: "starting" }))
    expect(restoreOf(app)).toEqual({ state: "starting", restored: "claude" })
    app.stop()
  })
})

describe("a program saved to resume", () => {
  it("is nothing to restore in a shell still live", async () => {
    const app = scripted(summary({ process: { name: "bash", argv: null } }), "claude")
    await flush()
    expect(restoreOf(app)).toEqual({ state: "idle", restored: undefined })
    app.stop()
  })

  it("waits through a restart with Enter until the fresh shell reports", async () => {
    const ended = { exit: { code: null, signal: "SIGKILL", ranMs: 9_000 }, process: null }
    const app = scripted(summary(ended), "claude")
    await flush()
    expect(restoreOf(app).restored).toBe("claude")
    app.restart(app.key)
    await flush()
    expect(restoreOf(app)).toEqual({ state: "starting", restored: "claude" })
    // The runner answers, and announces the fresh shell at its prompt.
    const fresh = summary({ run: 2, process: { name: "bash", argv: null } })
    app.restarts[0]!(fresh)
    app.changes.push({ type: "changed", terminal: fresh })
    await vi.waitFor(() => expect(restoreOf(app).state).toBe("idle"))
    expect(restoreOf(app)).toEqual({ state: "idle", restored: undefined })
    app.stop()
  })
})

describe("runs of a terminal", () => {
  context("while a restart has not answered yet", () => {
    it("ignores late reports about the run it replaces", async () => {
      const exited = { code: 2, signal: null, ranMs: 9_000 }
      const app = scripted(summary({ exit: exited, process: null }))
      await flush()
      app.restart(app.key)
      await flush()
      app.changes.push({
        type: "changed",
        terminal: summary({ exit: exited, process: null }),
      })
      app.changes.push({
        type: "changed",
        terminal: summary({ run: 2, process: { name: "vim", argv: null } }),
      })
      await flush()
      app.restarts[0]!(summary({ run: 2 }))
      await flush()
      expect(app.statusesOf()).toEqual([{ state: "starting" }, { state: "running" }])
      app.stop()
    })
  })

  context("when the watch starts a fresh sequence", () => {
    it("counts a terminal the new sequence leaves out as lost, without a reconnecting status", async () => {
      const app = scripted(summary({ run: 1 }))
      await flush()
      app.changes.push({ type: "changed", terminal: summary({ run: 1 }) })
      app.changes.push({ type: "synced" })
      // Reported during the old sequence, after its `synced`.
      app.changes.push({
        type: "changed",
        terminal: summary({ run: 1, process: { name: "vim", argv: null } }),
      })
      await flush()
      // The link came back at once: no reconnecting status, only a new sequence.
      app.changes.push({ type: "reset" })
      app.changes.push({ type: "synced" })
      await flush()
      expect(app.statusesOf()).toEqual([{ state: "running" }, { state: "starting" }])
      app.stop()
    })
  })

  context("when the runner comes back as a new process", () => {
    it("counts runs afresh", async () => {
      const app = scripted(summary({ run: 5 }))
      await flush()
      app.statuses.push({ state: "connected", epoch: "runner-2" })
      await flush()
      app.changes.push({
        type: "changed",
        terminal: summary({ run: 1, process: { name: "vim", argv: null } }),
      })
      await flush()
      expect(app.statusesOf()).toContainEqual({ state: "running" })
      app.stop()
    })
  })
})

const idle = {
  state: "idle" as const,
  attention: { pending: 0, kind: null, headline: null },
  subagents: [],
  planning: false,
  background: null,
  lastTurn: null,
}
const telemetry = (occupied: number) => ({
  context: { occupied, capacity: 200_000 },
  limits: [{ minutes: 300, used: 0.4, resetsAt: null }],
  model: "gpt-6-astra",
  effort: "high",
})
const codex = (occupied: number, change: Partial<TerminalSummary> = {}) =>
  summary({
    process: { name: "codex", argv: null },
    agent: "codex",
    activity: idle,
    telemetry: telemetry(occupied),
    ...change,
  })
const usageOf = (app: ReturnType<typeof scripted>) =>
  app.backend.telemetry.getSnapshot()["p/s"]?.[terminalId]

describe("an agent's telemetry", () => {
  it("is held from the start, apart from the terminal's status", async () => {
    const app = scripted(codex(1_000))
    await flush()
    expect(usageOf(app)).toEqual(telemetry(1_000))
    expect(restoreOf(app).state).toBe("running")
    app.stop()
  })

  it("leaves the terminal's status alone when it ticks, so no new roster follows", async () => {
    const app = scripted(codex(1_000))
    await flush()
    app.changes.push({ type: "changed", terminal: codex(1_000) })
    await flush()
    const reported = app.received.length
    const heard = vi.fn<() => void>()
    app.backend.telemetry.subscribe(heard)
    app.changes.push({ type: "changed", terminal: codex(2_000) })
    await vi.waitFor(() => expect(usageOf(app)?.context?.occupied).toBe(2_000))
    // Nothing reached the workspace: the store reduces what the adapter dispatches.
    expect(app.received).toHaveLength(reported)
    expect(heard).toHaveBeenCalledTimes(1)
    app.stop()
  })

  it("changes nothing when a tick repeats what is held", async () => {
    const app = scripted(codex(1_000))
    await flush()
    const held = app.backend.telemetry.getSnapshot()
    app.changes.push({ type: "changed", terminal: codex(1_000) })
    await flush()
    expect(app.backend.telemetry.getSnapshot()).toBe(held)
    app.stop()
  })

  it("comes with a terminal another client created", async () => {
    const app = scripted(summary({}))
    await flush()
    const other = "00000000-0000-4000-8000-000000000002"
    app.changes.push({ type: "changed", terminal: { ...codex(3_000), id: other } })
    await vi.waitFor(() =>
      expect(app.received.map((action) => action.type)).toContain("terminal/add"),
    )
    // The terminal joins the workspace, and its agent's usage shows with it.
    const added = app.received.filter((action) => action.type === "terminal/add")
    const seeded = workspaceFromSeed(app.backend.seed, {
      view: "grid",
      windowedView: "grid",
      now: 1,
    })
    app.backend.commit(added.reduce<Workspace>(workspaceReducer, seeded), added)
    expect(app.backend.telemetry.getSnapshot()["p/s"]?.[other]).toEqual(telemetry(3_000))
    app.stop()
  })

  it("is forgotten once its terminal is closed", async () => {
    const app = scripted(codex(1_000))
    await flush()
    const target = { projectId: "p", workspaceSessionId: "s" }
    const close = { type: "terminal/close" as const, target, terminalId }
    const seeded = workspaceFromSeed(app.backend.seed, {
      view: "grid",
      windowedView: "grid",
      now: 1,
    })
    app.backend.commit(workspaceReducer(seeded, close), [close])
    expect(usageOf(app)).toBeUndefined()
    app.stop()
  })

  it("is forgotten once the terminal's agent exits", async () => {
    const app = scripted(codex(1_000))
    await flush()
    app.changes.push({
      type: "changed",
      terminal: summary({ exit: { code: 1, signal: null, ranMs: 9_000 }, process: null }),
    })
    await vi.waitFor(() => expect(usageOf(app)).toBeUndefined())
    expect(app.backend.telemetry.getSnapshot()).toEqual({})
    app.stop()
  })
})

// A runner that holds one terminal at most.
const limited = await startTestRunner({ terminals: { maxTerminals: 1 } })
afterAll(() => limited.close())

describe("terminal limits and retries", () => {
  it("fails a terminal over the runner's limit instead of retrying it", async () => {
    const created = runnerBackend(limited.client, limited.listing, {
      theme: noTheme,
      saveDelay: 10,
    })
    const { backend } = created
    let workspace: Workspace = workspaceFromSeed(backend.seed, {
      view: "grid",
      windowedView: "grid",
      now: 1,
    })
    backend.commit(workspace, [])
    const received: BackendAction[] = []
    const stop = backend.start!({
      dispatch: (actions) => received.push(...actions),
      open: () => {},
    })
    const target = {
      projectId: workspace.activeProjectId,
      workspaceSessionId: activeSession(workspace)!.id,
    }
    for (const _ of [1, 2]) {
      const terminal = backend.newTerminal({ target, directory: "/tmp" })
      const action = { type: "terminal/add", target, terminal } as const
      workspace = workspaceReducer(workspace, action)
      backend.commit(workspace, [action])
    }
    await created.idle()
    expect(received).toContainEqual(
      expect.objectContaining({
        type: "terminal/status",
        status: { state: "failed", message: "Terminal limit reached" },
      }),
    )
    stop()
  })

  it("stops retrying a busy runner once the terminal is closed", async () => {
    let creates = 0
    const busy = {
      ...limited.client,
      watch: () => limited.client.watch(),
      terminals: {
        ...limited.client.terminals,
        watch: () => limited.client.terminals.watch(),
        create: async () => {
          creates += 1
          throw new WireError("RESOURCE_LIMIT")
        },
      },
    } as RunnerApi
    const created = runnerBackend(busy, limited.listing, { theme: noTheme, saveDelay: 10 })
    const { backend } = created
    let workspace = workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 1 })
    backend.commit(workspace, [])
    const target = {
      projectId: workspace.activeProjectId,
      workspaceSessionId: activeSession(workspace)!.id,
    }
    const terminal = backend.newTerminal({ target, directory: "/tmp" })
    const add = { type: "terminal/add", target, terminal } as const
    workspace = workspaceReducer(workspace, add)
    backend.commit(workspace, [add])
    await vi.waitFor(() => expect(creates).toBeGreaterThan(1))
    const close = { type: "terminal/close", target, terminalId: terminal.id } as const
    backend.commit(workspaceReducer(workspace, close), [close])
    await created.idle()
    const after = creates
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(creates).toBe(after)
  })
})
