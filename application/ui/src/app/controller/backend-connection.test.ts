import type { Backend, BackendSink } from "../../backend/port"
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
      connectBackend(backend, store)
      sinks[0]!.dispatch([
        { type: "terminal/status", target, terminalId: "01", status: { state: "finished" } },
        {
          type: "terminal/status",
          target,
          terminalId: "02",
          status: { state: "exited", exitCode: 0 },
        },
      ])
      expect(statuses(store.getSnapshot())).toEqual(["finished", "exited"])
      expect(notifications).toBe(1)
    })

    it("ignores changes for a terminal that no longer exists", () => {
      const store = createWorkspaceStore(workspace())
      const { backend, sinks } = startable()
      connectBackend(backend, store)
      const before = store.getSnapshot()
      sinks[0]!.dispatch([
        { type: "terminal/status", target, terminalId: "gone", status: { state: "idle" } },
      ])
      expect(store.getSnapshot()).toBe(before)
    })
  })

  context("when stopped", () => {
    it("stops the backend and drops what the old sink reports afterwards", () => {
      const store = createWorkspaceStore(workspace())
      const { backend, sinks, stops } = startable()
      const stop = connectBackend(backend, store)
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
      connectBackend(backend, store)()
      connectBackend(backend, store)
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
      const stop = connectBackend({}, store)
      expect(stop).not.toThrow()
    })
  })
})
