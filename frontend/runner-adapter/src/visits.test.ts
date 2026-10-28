import { workspaceFromSeed } from "@novadeck/core/seed"
import {
  createTerminalState,
  createWorkspaceSession,
  workspaceReducer,
  type WorkspaceAction,
} from "@novadeck/core/state"
import type { Workspace } from "@novadeck/core/types"
import type { Project } from "@novadeck/protocol"
import { afterEach, beforeEach, vi } from "vitest"

import { createSessionSaves } from "./saves"
import { runnerSeed, type RunnerListing } from "./seed"
import { encodeSession } from "./session-state"
import { context, describe, expect, it } from "./test"

const defaults = { view: "grid", windowedView: "grid", now: 1 } as const
const state = () => createTerminalState([], "grid", "grid")
const project = (id: string): Project => ({ id, name: id, cwd: `/work/${id}`, pinned: false })

// Two projects with two sessions each, last visited as the numbers say; null for never.
const listing = (visits: Record<string, number | null>): RunnerListing =>
  ["a", "b"].map((projectId) => ({
    project: project(projectId),
    sessions: ["1", "2"].map((n) => {
      const id = `${projectId}${n}`
      const visitedAt = visits[id] ?? null
      const session = { id, name: id, visitedAt, state: state() }
      return {
        session: { id, projectId, name: id, visitedAt, state: encodeSession(session) },
        terminals: [],
      }
    }),
  }))

// What the runner holds once every session was saved as the workspace has it.
const reload = (workspace: Workspace): RunnerListing =>
  workspace.projects.map((each) => ({
    project: project(each.id),
    sessions: each.history.map((session) => ({
      session: {
        id: session.id,
        projectId: each.id,
        name: session.name,
        visitedAt: session.visitedAt,
        state: encodeSession(session),
      },
      terminals: [],
    })),
  }))

const open = (from: RunnerListing): Workspace => workspaceFromSeed(runnerSeed(from), defaults)
// The project and the session each project has open, as a restart finds them.
const opened = (workspace: Workspace) => ({
  project: workspace.activeProjectId,
  sessions: Object.fromEntries(workspace.projects.map((each) => [each.id, each.activeSessionId])),
})
const apply = (workspace: Workspace, ...actions: WorkspaceAction[]): Workspace =>
  actions.reduce(workspaceReducer, workspace)

// Opens with a2 in b's project the last visited: b open, a1 the latest of a.
const start = () => open(listing({ a1: 30, a2: 10, b1: 20, b2: 50 }))

describe("session visits across a restart", () => {
  it("opens what the seed finds open to begin with", () => {
    expect(opened(start())).toEqual({ project: "b", sessions: { a: "a1", b: "b2" } })
  })

  context("when the person selects another project", () => {
    it("opens it, and the session it had open in the project they left", () => {
      // The clock stands still, or runs behind a stamp: the order still holds.
      for (const now of [1, 40, 51, 10_000]) {
        const after = apply(start(), { type: "project/select", projectId: "a", now })
        expect(opened(open(reload(after)))).toEqual({
          project: "a",
          sessions: { a: "a1", b: "b2" },
        })
        const back = apply(after, { type: "project/select", projectId: "b", now })
        expect(opened(open(reload(back)))).toEqual({
          project: "b",
          sessions: { a: "a1", b: "b2" },
        })
      }
    })
  })

  context("when the person selects another session", () => {
    it("opens it, and the one they left is the next the project opens", () => {
      for (const now of [1, 51, 10_000]) {
        const select = (to: string): WorkspaceAction => ({
          type: "session/select",
          projectId: "b",
          workspaceSessionId: to,
          now,
        })
        const after = apply(start(), select("b1"))
        expect(opened(open(reload(after)))).toEqual({
          project: "b",
          sessions: { a: "a1", b: "b1" },
        })
        const back = apply(after, select("b2"))
        expect(opened(open(reload(back)))).toEqual({
          project: "b",
          sessions: { a: "a1", b: "b2" },
        })
      }
    })
  })

  context("when the person adds a session", () => {
    it("opens it, and the project's earlier session follows", () => {
      for (const now of [1, 10_000]) {
        const session = createWorkspaceSession({ name: "new", state: state() }, { id: "b3", now })
        const after = apply(start(), { type: "session/add", projectId: "b", session })
        const next = open(reload(after))
        expect(opened(next)).toEqual({ project: "b", sessions: { a: "a1", b: "b3" } })
        expect(next.projects[1]!.history.map((each) => each.id)).toEqual(["b3", "b2", "b1"])
      }
    })

    it("opens a session added to a project that wasn't open, only once it is selected", () => {
      const session = createWorkspaceSession({ name: "new", state: state() }, { id: "a3", now: 5 })
      const added = apply(start(), { type: "session/add", projectId: "a", session })
      expect(opened(open(reload(added))).project).toBe("a")
      const back = apply(added, { type: "project/select", projectId: "b", now: 5 })
      expect(opened(open(reload(back)))).toEqual({ project: "b", sessions: { a: "a3", b: "b2" } })
    })

    it("keeps one added in the background unvisited", () => {
      const session = createWorkspaceSession(
        { name: "new", state: state() },
        { id: "b3", now: 9_000 },
      )
      const after = apply(start(), {
        type: "session/add",
        projectId: "b",
        session,
        activate: false,
      })
      expect(opened(open(reload(after)))).toEqual({ project: "b", sessions: { a: "a1", b: "b2" } })
    })
  })

  context("when the person adds a project", () => {
    it("opens it, and the session the left project had open stays its choice", () => {
      for (const now of [1, 10_000]) {
        const initialSession = createWorkspaceSession(
          { name: "first", state: state() },
          { id: "c1", now },
        )
        const after = apply(start(), {
          type: "project/add",
          project: { id: "c", name: "c", directory: "/work/c" },
          activate: true,
          initialSession,
        })
        const next = open(reload(after))
        expect(opened(next)).toEqual({ project: "c", sessions: { a: "a1", b: "b2", c: "c1" } })
        const back = apply(after, { type: "project/select", projectId: "b", now })
        expect(opened(open(reload(back))).project).toBe("b")
      }
    })

    it("leaves one added in the background unvisited", () => {
      const initialSession = createWorkspaceSession(
        { name: "first", state: state() },
        { id: "c1", now: 9_000 },
      )
      const after = apply(start(), {
        type: "project/add",
        project: { id: "c", name: "c", directory: "/work/c" },
        initialSession,
      })
      expect(opened(open(reload(after))).project).toBe("b")
    })
  })

  context("when a route opens a project and a session in one go", () => {
    it("opens that session, though both actions share a moment", () => {
      const now = 60
      const after = apply(
        start(),
        { type: "project/select", projectId: "a", now },
        { type: "session/select", projectId: "a", workspaceSessionId: "a2", now },
      )
      expect(opened(open(reload(after)))).toEqual({ project: "a", sessions: { a: "a2", b: "b2" } })
    })
  })

  context("when a session never visited changes", () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it("is not made the latest, so the session visited before still opens", async () => {
      // The runner holds what was saved: b2 was visited, a2 and the rest never.
      const held = new Map<string, { state: string; visitedAt: number | null }>()
      let from = listing({ b2: 50 })
      const run = async (): Promise<Workspace> => {
        let latest = open(from)
        const saves = createSessionSaves({
          save: async (sessionId, text, visitedAt) => {
            held.set(sessionId, { state: text, visitedAt })
          },
          ready: () => Promise.resolve(true),
          latest: () => latest,
          track: (work) => work,
          halted: () => false,
          delay: 10,
          saved: [],
        })
        saves.note(latest)
        // A terminal turns up in a session the person never opened.
        const next = apply(latest, {
          type: "terminal/add",
          target: { projectId: "a", workspaceSessionId: "a2" },
          terminal: {
            id: "t1",
            name: "T",
            directory: "/work/a",
            command: "",
            process: "",
            state: "idle",
          },
          select: false,
        })
        latest = next
        saves.note(next)
        await vi.advanceTimersByTimeAsync(100)
        return latest
      }
      const first = await run()
      expect(opened(first)).toEqual({ project: "b", sessions: { a: "a1", b: "b2" } })
      expect(held.get("a2")).toMatchObject({ visitedAt: null })
      // Restart on what the runner now holds.
      from = from.map(({ project: each, sessions }) => ({
        project: each,
        sessions: sessions.map((entry) => {
          const saved = held.get(entry.session.id)
          return saved ? { ...entry, session: { ...entry.session, ...saved } } : entry
        }),
      }))
      expect(opened(open(from))).toEqual({ project: "b", sessions: { a: "a1", b: "b2" } })
    })
  })
})
