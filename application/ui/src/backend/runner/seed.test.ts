import type { Project, TerminalSummary, WorkspaceSession } from "@novadeck/protocol"

import { setTerminalProcess, setTerminalStatus } from "../../model/roster"
import { workspaceFromSeed } from "../../model/seed"
import { createTerminalState } from "../../model/state"
import type { TerminalStatus, WorkspaceSession as Session, WorkspaceState } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import { cleanlyExited, lostTerminals, runnerSeed, type RunnerListing } from "./seed"
import { decodeSession, encodeSession } from "./session-state"

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const project = (n: number): Project => ({ id: uuid(n), name: `Project ${n}`, cwd: `/work/${n}` })
const summary = (n: number, session: number, change: Partial<TerminalSummary> = {}) => ({
  id: uuid(n),
  sessionId: uuid(session),
  cwd: "/work/1",
  cols: 80,
  rows: 24,
  exit: null,
  run: 1,
  process: { name: "zsh", argv: null },
  ...change,
})
const foreground = (name: string) => ({ process: { name, argv: null } })
const saved = (
  id: number,
  visitedAt: number,
  terminals: readonly {
    readonly id: string
    readonly name: string
    // The program running when the session was saved.
    readonly running?: string
  }[],
  change: Partial<WorkspaceState> = {},
  rank = 0,
): WorkspaceSession => {
  const metadata = terminals.map(({ running, ...terminal }) => ({
    ...terminal,
    directory: "/work/1",
    command: "",
    process: running ?? "",
    state: running ? ("running" as const) : ("idle" as const),
  }))
  const state = createTerminalState(metadata, "grid", "grid")
  return {
    id: uuid(id),
    projectId: uuid(1),
    name: `Session ${id}`,
    state: encodeSession(
      {
        id: uuid(id),
        name: `Session ${id}`,
        visitedAt,
        state: { ...state, roster: { ...state.roster, nextNumber: 5 }, ...change },
      },
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

// What the next save records for the session's first terminal.
const resave = (current: Session) =>
  decodeSession(encodeSession(current, 2))!.state.roster.terminals[0]!.lastProcess
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

  context("with a saved session and the terminals the runner still has", () => {
    const listing: RunnerListing = [
      {
        project: project(1),
        sessions: [
          {
            session: saved(
              10,
              500,
              [
                { id: uuid(20), name: "server" },
                { id: uuid(21), name: "gone" },
              ],
              { selected: uuid(21), view: "canvas" },
            ),
            terminals: [
              summary(20, 10, foreground("node")),
              summary(22, 10, foreground("vim")),
              summary(23, 10, {
                exit: { code: 1, signal: null, ranMs: 9_000 },
                process: null,
              }),
            ],
          },
        ],
      },
    ]
    const state = workspaceFromSeed(runnerSeed(listing), defaults).projects[0]!.history[0]!.state

    it("keeps saved names, selection and view with the runner's live status", () => {
      expect(state).toMatchObject({ view: "canvas", selected: uuid(21) })
      expect(state.roster.terminals[0]).toMatchObject({
        id: uuid(20),
        name: "server",
        state: "running",
        process: "node",
      })
    })

    it("keeps a saved terminal the runner lost in place, waiting for a fresh shell", () => {
      expect(state.roster.terminals[1]).toMatchObject({
        id: uuid(21),
        name: "gone",
        state: "starting",
      })
      expect([...lostTerminals(listing)]).toEqual([uuid(21)])
    })

    it("appends running terminals the save did not know, named from the saved counter", () => {
      expect(state.roster.terminals[2]).toMatchObject({
        id: uuid(22),
        name: "Terminal 05",
        directory: "/work/1",
        state: "running",
      })
      expect(state.roster.nextNumber).toBe(6)
      expect(state.layout.grid.desktop?.some((item) => item.i === uuid(22))).toBe(true)
    })
  })

  context("with a program saved to resume", () => {
    const session = saved(10, 500, [{ id: uuid(20), name: "Agent", running: "codex" }])
    const seeded = (terminals: TerminalSummary[]) =>
      workspaceFromSeed(
        runnerSeed([{ project: project(1), sessions: [{ session, terminals }] }]),
        defaults,
      ).projects[0]!.history[0]!

    it("restores it where the runner lost the terminal or its shell ended", () => {
      expect(first(seeded([]))).toMatchObject({ restoredProcess: "codex", state: "starting" })
      const killed = { exit: { code: null, signal: "SIGKILL", ranMs: 9_000 }, process: null }
      const failed = { exit: { code: 1, signal: null, ranMs: 10 }, process: null }
      for (const ended of [killed, failed])
        expect(first(seeded([summary(20, 10, ended)])).restoredProcess).toBe("codex")
    })

    it("has nothing to restore in a shell still live, at its prompt or running a program", () => {
      const idle = seeded([summary(20, 10)])
      expect(first(idle)).not.toHaveProperty("restoredProcess")
      expect(resave(idle)).toBe("")
      const running = seeded([summary(20, 10, foreground("server"))])
      expect(first(running)).not.toHaveProperty("restoredProcess")
      expect(resave(running)).toBe("server")
    })
  })

  context("when a running program loses its shell", () => {
    const current = saved(10, 500, [{ id: uuid(20), name: "Agent", running: "claude" }])
    const running = workspaceFromSeed(
      runnerSeed([
        {
          project: project(1),
          sessions: [{ session: current, terminals: [summary(20, 10, foreground("claude"))] }],
        },
      ]),
      defaults,
    ).projects[0]!.history[0]!
    const lost = run(running, { state: "starting" }, "claude")

    it("keeps it to resume when the runner loses the shell, or it is killed or fails", () => {
      const ends: TerminalStatus[] = [
        { state: "starting" },
        { state: "exited", exitCode: null, signal: "SIGKILL" },
        { state: "failed", message: "Runner restarting" },
      ]
      for (const status of ends) {
        const ended = run(running, status, "claude")
        expect(first(ended).restoredProcess).toBe("claude")
        expect(resave(ended)).toBe("claude")
      }
    })

    it("keeps it while the replacement shell starts or ends again", () => {
      const ended = run(lost, { state: "exited", exitCode: 1, signal: null }, "claude")
      expect(first(ended).restoredProcess).toBe("claude")
    })

    it("drops it once a shell is live again, at its prompt or running a program", () => {
      const prompt = run(lost, { state: "idle" }, "bash")
      expect(first(prompt)).not.toHaveProperty("restoredProcess")
      expect(resave(prompt)).toBe("")
      const startup = run(lost, { state: "running" }, "fastfetch")
      expect(first(startup)).not.toHaveProperty("restoredProcess")
      expect(resave(startup)).toBe("fastfetch")
    })

    it("has nothing to restore once the program ended at the prompt", () => {
      expect(resave(run(running, { state: "idle" }, "bash"))).toBe("")
    })
  })

  context("with exited terminals the save does not know", () => {
    it("leaves them out, as they were closed", () => {
      const listing: RunnerListing = [
        {
          project: project(1),
          sessions: [
            {
              session: saved(10, 1, []),
              terminals: [
                summary(20, 10, {
                  exit: { code: 3, signal: null, ranMs: 9_000 },
                  process: null,
                }),
              ],
            },
          ],
        },
      ]
      expect(runnerSeed(listing).projects[0]!.sessions[0]!.terminals).toEqual([])
    })
  })

  context("with a saved terminal whose shell exited cleanly", () => {
    it("closes it, as it would have closed on screen", () => {
      const listing: RunnerListing = [
        {
          project: project(1),
          sessions: [
            {
              session: saved(10, 1, [{ id: uuid(20), name: "done" }]),
              terminals: [
                summary(20, 10, {
                  exit: { code: 0, signal: null, ranMs: 9_000 },
                  process: null,
                }),
              ],
            },
          ],
        },
      ]
      expect(runnerSeed(listing).projects[0]!.sessions[0]!.terminals).toEqual([])
      expect(cleanlyExited(listing)).toEqual([uuid(20)])
    })

    it("hands its selection to a terminal that remains", () => {
      const listing: RunnerListing = [
        {
          project: project(1),
          sessions: [
            {
              session: saved(
                10,
                1,
                [
                  { id: uuid(20), name: "done" },
                  { id: uuid(21), name: "kept" },
                ],
                { selected: uuid(20) },
              ),
              terminals: [
                summary(20, 10, {
                  exit: { code: 0, signal: null, ranMs: 9_000 },
                  process: null,
                }),
                summary(21, 10),
              ],
            },
          ],
        },
      ]
      expect(runnerSeed(listing).projects[0]!.sessions[0]!.restored?.selected).toBe(uuid(21))
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

    it("names the terminals of an unsaved session in the runner's order", () => {
      expect(seed.projects[0]!.sessions[2]!.terminals.map((terminal) => terminal.name)).toEqual([
        "Terminal 01",
        "Terminal 02",
      ])
    })
  })
})
