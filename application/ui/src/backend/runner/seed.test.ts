import type { Project, TerminalSummary, WorkspaceSession } from "@novadeck/protocol"

import { initialGridLayouts } from "../../model/layout/grid-placement"
import { setTerminalProcess, setTerminalStatus } from "../../model/roster"
import { workspaceFromSeed } from "../../model/seed"
import { createTerminalState } from "../../model/state"
import type { TerminalStatus, WorkspaceSession as Session, WorkspaceState } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { cleanlyExited, lostTerminals, runnerSeed, type RunnerListing } from "./seed"
import { encodeSession } from "./session-state"

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const project = (n: number): Project => ({ id: uuid(n), name: `Project ${n}`, cwd: `/work/${n}` })
// A terminal as the runner reports it: live, unless `started` says it keeps it only saved.
const summary = (
  n: number,
  session: number,
  change: Partial<TerminalSummary> = {},
): TerminalSummary => ({
  id: uuid(n),
  sessionId: uuid(session),
  title: `Terminal ${n}`,
  titleSource: { kind: "default" },
  handle: `t${n}`,
  started: true,
  command: null,
  lastProgram: null,
  cwd: "/work/1",
  cols: 80,
  rows: 24,
  exit: null,
  run: 1,
  process: { name: "zsh", argv: null },
  agent: null,
  activity: null,
  telemetry: null,
  ...change,
})
const kept = (n: number, session: number, change: Partial<TerminalSummary> = {}) =>
  summary(n, session, { started: false, run: 0, process: null, ...change })
const foreground = (name: string) => ({ process: { name, argv: null } })
// A session the UI saved, having laid out these terminals.
const saved = (
  id: number,
  visitedAt: number,
  ids: readonly number[],
  change: Partial<WorkspaceState> = {},
  rank = 0,
): WorkspaceSession => {
  const metadata = ids.map((n) => ({
    id: uuid(n),
    name: "",
    directory: "/work/1",
    command: "",
    process: "",
    state: "idle" as const,
  }))
  const state = createTerminalState(metadata, "grid", "grid", {
    gridLayouts: initialGridLayouts(metadata),
  })
  return {
    id: uuid(id),
    projectId: uuid(1),
    name: `Session ${id}`,
    state: encodeSession(
      { id: uuid(id), name: `Session ${id}`, visitedAt, state: { ...state, ...change } },
      rank,
    ),
  }
}
const fresh = (id: number, projectId = 1): WorkspaceSession => ({
  id: uuid(id),
  projectId: uuid(projectId),
  name: `Session ${id}`,
  state: null,
})
const defaults = { view: "focus", windowedView: "grid", now: 99 } as const

// The first terminal after the backend reports `status`, then `process`, as it does.
const run = (current: Session, status: TerminalStatus, process: string): Session => {
  const id = current.state.roster.terminals[0]!.id
  const roster = setTerminalProcess(
    setTerminalStatus(current.state.roster, id, status),
    id,
    process,
  )
  return { ...current, state: { ...current.state, roster } }
}
const first = (current: Session) => current.state.roster.terminals[0]!
const seeded = (session: WorkspaceSession, terminals: TerminalSummary[]) =>
  workspaceFromSeed(
    runnerSeed([{ project: project(1), sessions: [{ session, terminals }] }]),
    defaults,
  ).projects[0]!.history[0]!

describe("runner seed", () => {
  context("on a first run", () => {
    const listing: RunnerListing = [
      { project: project(1), sessions: [{ session: fresh(10), terminals: [] }] },
    ]

    it("opens the only project with an empty session in the default views", () => {
      const workspace = workspaceFromSeed(runnerSeed(listing), defaults)
      expect(workspace.activeProjectId).toBe(uuid(1))
      expect(workspace.projects[0]).toMatchObject({
        directory: "/work/1",
        activeSessionId: uuid(10),
      })
      expect(workspace.projects[0]!.history[0]!.state).toMatchObject({
        view: "focus",
        roster: { terminals: [] },
      })
    })
  })

  context("with a saved view and the runner's terminals", () => {
    const listing: RunnerListing = [
      {
        project: project(1),
        sessions: [
          {
            // The view laid out 20, 21 and 24, and selected 24, which the runner no longer has.
            session: saved(10, 500, [20, 21, 24], { selected: uuid(24), view: "canvas" }),
            terminals: [
              summary(20, 10, { ...foreground("node"), title: "server", cwd: "/work/1/api" }),
              kept(21, 10, { title: "gone" }),
              summary(22, 10, { ...foreground("vim"), command: "vim" }),
              summary(23, 10, { exit: { code: 1, signal: null, ranMs: 9_000 }, process: null }),
            ],
          },
        ],
      },
    ]
    const state = workspaceFromSeed(runnerSeed(listing), defaults).projects[0]!.history[0]!.state

    it("shows the runner's terminals with its names, directories and live status", () => {
      expect(state.view).toBe("canvas")
      expect(state.roster.terminals[0]).toMatchObject({
        id: uuid(20),
        name: "server",
        directory: "/work/1/api",
        state: "running",
        process: "node",
      })
    })

    it("keeps a terminal the runner has no shell for in place, waiting for a fresh one", () => {
      expect(state.roster.terminals[1]).toMatchObject({
        id: uuid(21),
        name: "gone",
        state: "starting",
      })
      expect([...lostTerminals(listing)]).toEqual([uuid(21)])
    })

    it("lays out terminals the view didn't know after the others, as the runner names them", () => {
      expect(state.roster.terminals.slice(2)).toMatchObject([
        { id: uuid(22), name: "Terminal 22", command: "vim", state: "running" },
        { id: uuid(23), name: "Terminal 23", state: "exited", exitCode: 1 },
      ])
      expect(state.layout.canvas.geometry[uuid(22)]).toBeDefined()
    })

    it("drops what it kept of a terminal the runner no longer has, handing selection on", () => {
      expect(state.roster.terminals.map((terminal) => terminal.id)).not.toContain(uuid(24))
      expect(state.layout.canvas.geometry[uuid(24)]).toBeUndefined()
      expect(state.layout.grid.desktop?.some((item) => item.i === uuid(24))).toBe(false)
      expect(state.selected).toBe(uuid(20))
    })
  })

  context("with a program to resume", () => {
    const session = saved(10, 500, [20])

    it("restores the program the runner last saw where it has no shell, or its shell ended", () => {
      const lost = kept(20, 10, { lastProgram: "codex" })
      expect(first(seeded(session, [lost]))).toMatchObject({
        restoredProcess: "codex",
        state: "starting",
      })
      const killed = { exit: { code: null, signal: "SIGKILL", ranMs: 9_000 }, process: null }
      const failed = { exit: { code: 1, signal: null, ranMs: 10 }, process: null }
      for (const ended of [killed, failed])
        expect(
          first(seeded(session, [summary(20, 10, { ...ended, lastProgram: "codex" })]))
            .restoredProcess,
        ).toBe("codex")
    })

    it("has nothing to restore in a shell still live, or where the last program was the shell", () => {
      expect(
        first(seeded(session, [summary(20, 10, { lastProgram: "claude" })])),
      ).not.toHaveProperty("restoredProcess")
      expect(first(seeded(session, [kept(20, 10, { lastProgram: "zsh" })]))).not.toHaveProperty(
        "restoredProcess",
      )
    })
  })

  context("when a running program loses its shell", () => {
    const running = seeded(saved(10, 500, [20]), [summary(20, 10, foreground("claude"))])
    const lost = run(running, { state: "starting" }, "claude")

    it("keeps it to resume when the runner loses the shell, or it is killed or fails", () => {
      const ends: TerminalStatus[] = [
        { state: "starting" },
        { state: "exited", exitCode: null, signal: "SIGKILL" },
        { state: "failed", message: "Runner restarting" },
      ]
      for (const status of ends)
        expect(first(run(running, status, "claude")).restoredProcess).toBe("claude")
    })

    it("keeps it while the replacement shell starts or ends again", () => {
      const ended = run(lost, { state: "exited", exitCode: 1, signal: null }, "claude")
      expect(first(ended).restoredProcess).toBe("claude")
    })

    it("drops it once a shell is live again, at its prompt or running a program", () => {
      expect(first(run(lost, { state: "idle" }, "bash"))).not.toHaveProperty("restoredProcess")
      expect(first(run(lost, { state: "running" }, "fastfetch"))).not.toHaveProperty(
        "restoredProcess",
      )
    })
  })

  context("with a terminal whose shell exited cleanly", () => {
    it("closes it, as it would have closed on screen", () => {
      const listing: RunnerListing = [
        {
          project: project(1),
          sessions: [
            {
              session: saved(10, 1, [20]),
              terminals: [
                summary(20, 10, { exit: { code: 0, signal: null, ranMs: 9_000 }, process: null }),
              ],
            },
          ],
        },
      ]
      expect(runnerSeed(listing).projects[0]!.sessions[0]!.terminals).toEqual([])
      expect(cleanlyExited(listing)).toEqual([uuid(20)])
    })
  })

  context("with a view saved before the runner kept terminals", () => {
    it("reads none of it, and shows the runner's terminals", () => {
      const state = JSON.stringify({
        version: 1,
        visitedAt: 7,
        rank: 2,
        state: {
          roster: {
            terminals: [{ id: uuid(20), name: "old name", directory: "/old", lastProcess: "" }],
            order: [uuid(20)],
            nextNumber: 9,
          },
          layout: createTerminalState(
            [{ id: uuid(20), name: "", directory: "", command: "", process: "", state: "idle" }],
            "grid",
            "grid",
          ).layout,
          view: "grid",
          windowedView: "grid",
          selected: uuid(20),
        },
      })
      const session = { ...fresh(10), state }
      const current = seeded(session, [summary(20, 10, { title: "runner name" })])
      expect(current.state.roster).toMatchObject({
        terminals: [{ id: uuid(20), name: "runner name", directory: "/work/1" }],
      })
    })
  })

  context("with sessions visited at the same moment", () => {
    it("opens the session and project that were open", () => {
      const listing: RunnerListing = [
        {
          project: project(1),
          sessions: [
            { session: saved(10, 500, [], {}, 0), terminals: [] },
            { session: saved(11, 500, [], {}, 1), terminals: [] },
          ],
        },
        {
          project: project(2),
          sessions: [
            { session: { ...saved(12, 500, [], {}, 2), projectId: uuid(2) }, terminals: [] },
          ],
        },
      ]
      const seed = runnerSeed(listing)
      expect(seed.projects[0]!.sessions.map((session) => session.id)).toEqual([uuid(11), uuid(10)])
      expect(seed.activeProjectId).toBe(uuid(2))
    })
  })

  context("with several projects and sessions", () => {
    const listing: RunnerListing = [
      {
        project: project(1),
        sessions: [
          { session: fresh(10), terminals: [summary(30, 10), summary(31, 10)] },
          { session: saved(11, 100, []), terminals: [] },
          { session: saved(12, 300, []), terminals: [] },
        ],
      },
      {
        project: project(2),
        sessions: [{ session: { ...saved(13, 400, []), projectId: uuid(2) }, terminals: [] }],
      },
    ]
    const seed = runnerSeed(listing)

    it("orders sessions by their last visit, with unsaved ones last", () => {
      expect(seed.projects[0]!.sessions.map((session) => session.id)).toEqual([
        uuid(12),
        uuid(11),
        uuid(10),
      ])
    })

    it("opens the project visited most recently", () => {
      expect(seed.activeProjectId).toBe(uuid(2))
    })

    it("names the terminals of an unsaved session as the runner does, in its order", () => {
      expect(seed.projects[0]!.sessions[2]!.terminals.map((terminal) => terminal.name)).toEqual([
        "Terminal 30",
        "Terminal 31",
      ])
    })
  })
})
