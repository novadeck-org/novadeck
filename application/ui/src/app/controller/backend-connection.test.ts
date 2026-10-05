import type { Backend, BackendSink, TerminalRequest } from "../../backend/port"
import { createTerminalState } from "../../model/state"
import { createWorkspaceStore } from "../../model/store"
import type { Workspace } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { terminalFixture } from "../../test/fixtures"
import { connectBackend } from "./backend-connection"

const target = { projectId: "project", workspaceSessionId: "initial" }
const workspace = (): Workspace => ({
  activeProjectId: "project",
  projects: [
    {
      id: "project",
      name: "Project",
      directory: "~/project",
      activeSessionId: "initial",
      history: [
        {
          id: "initial",
          name: "initial",
          visitedAt: 0,
          state: createTerminalState(
            [terminalFixture(1, "~/project"), terminalFixture(2, "~/project")],
            "grid",
            "grid",
          ),
        },
      ],
    },
  ],
})
const statuses = (snapshot: Workspace): string[] =>
  snapshot.projects[0]!.history[0]!.state.roster.terminals.map((terminal) => terminal.state)

// The app's handling of a request for a terminal, where a test has none.
const refuse = (request: TerminalRequest): void => request.answer({ reason: "Not here." })

// A request from terminal 01, noting its answers.
const request = () => {
  const answers: unknown[] = []
  const asked: TerminalRequest = {
    from: "01",
    directory: "~/project",
    command: "claude",
    focus: false,
    answer: (result) => answers.push(result),
  }
  return { asked, answers }
}

// A backend whose start hands out its sink and counts how often it was stopped.
const startable = () => {
  const sinks: BackendSink[] = []
  let stops = 0
  const backend: Pick<Backend, "start"> = {
    start: (sink) => {
      sinks.push(sink)
      return () => stops++
    },
  }
  return { backend, sinks, stops: () => stops }
}

describe("backend connection", () => {
  context("when the backend reports several changes at once", () => {
    it("commits them as one transaction", () => {
      const store = createWorkspaceStore(workspace())
      const { backend, sinks } = startable()
      let notifications = 0
      store.subscribe(() => notifications++)
      connectBackend(backend, store, refuse)
      sinks[0]!.dispatch([
        { type: "terminal/status", target, terminalId: "01", status: { state: "finished" } },
        {
          type: "terminal/status",
          target,
          terminalId: "02",
          status: { state: "exited", exitCode: 0, signal: null },
        },
      ])
      expect(statuses(store.getSnapshot())).toEqual(["finished", "exited"])
      expect(notifications).toBe(1)
    })

    it("ignores changes for a terminal that no longer exists", () => {
      const store = createWorkspaceStore(workspace())
      const { backend, sinks } = startable()
      connectBackend(backend, store, refuse)
      const before = store.getSnapshot()
      sinks[0]!.dispatch([
        { type: "terminal/status", target, terminalId: "gone", status: { state: "idle" } },
      ])
      expect(store.getSnapshot()).toBe(before)
    })
  })

  context("when the backend hands over a request for a terminal", () => {
    it("passes it to the app while connected, and refuses it once stopped", () => {
      const store = createWorkspaceStore(workspace())
      const { backend, sinks } = startable()
      const handled: TerminalRequest[] = []
      const stop = connectBackend(backend, store, (asked) => handled.push(asked))
      const live = request()
      sinks[0]!.open(live.asked)
      expect(handled).toEqual([live.asked])
      expect(live.answers).toEqual([])
      stop()
      const late = request()
      sinks[0]!.open(late.asked)
      expect(handled).toHaveLength(1)
      expect(late.answers).toEqual([{ reason: "Novadeck closed before it opened the terminal." }])
    })
  })

  context("when stopped", () => {
    it("stops the backend and drops what the old sink reports afterwards", () => {
      const store = createWorkspaceStore(workspace())
      const { backend, sinks, stops } = startable()
      const stop = connectBackend(backend, store, refuse)
      stop()
      sinks[0]!.dispatch([
        { type: "terminal/status", target, terminalId: "01", status: { state: "finished" } },
      ])
      expect(stops()).toBe(1)
      expect(statuses(store.getSnapshot())).toEqual(["idle", "idle"])
    })
  })

  context("when StrictMode starts, stops and starts the same backend", () => {
    it("delivers events only through the latest sink", () => {
      const store = createWorkspaceStore(workspace())
      const { backend, sinks } = startable()
      connectBackend(backend, store, refuse)()
      connectBackend(backend, store, refuse)
      sinks[0]!.dispatch([
        { type: "terminal/status", target, terminalId: "01", status: { state: "finished" } },
      ])
      sinks[1]!.dispatch([
        { type: "terminal/status", target, terminalId: "02", status: { state: "running" } },
      ])
      expect(statuses(store.getSnapshot())).toEqual(["idle", "running"])
    })
  })

  context("when the backend reports nothing", () => {
    it("connects and stops without starting anything", () => {
      const store = createWorkspaceStore(workspace())
      const stop = connectBackend({}, store, refuse)
      expect(stop).not.toThrow()
    })
  })
})
