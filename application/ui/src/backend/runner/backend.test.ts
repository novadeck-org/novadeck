import { afterAll, vi } from "vitest"

import { workspaceFromSeed } from "../../model/seed"
import {
  activeProject,
  activeSession,
  createTerminalState,
  workspaceReducer,
  type WorkspaceAction,
} from "../../model/state"
import type { Workspace, WorkspaceTarget } from "../../model/types"
import { context, describe, expect, it } from "../../test"
import type { BackendAction } from "../port"
import { runnerBackend, type RunnerBackend, type RunnerBackendOptions } from "./backend"
import { runnerSeed, startingTerminal, type RunnerListing } from "./seed"
import { decodeSession, encodeSession } from "./session-state"
import { startTestRunner, typeInto } from "./testing"

// The runner samples the foreground process about once a second.
const eventually = { timeout: 5000 }

// Real shells, exits and restarts take a few seconds each.
vi.setConfig({ testTimeout: 20_000 })

const runner = await startTestRunner()
afterAll(() => runner.close())

// A backend over the runner as the app drives it: seeded, committed and started.
const open = (listing: RunnerListing = runner.listing, options: RunnerBackendOptions = {}) => {
  const created: RunnerBackend = runnerBackend(runner.client, listing, {
    saveDelay: 10,
    ...options,
  })
  const { backend } = created
  let workspace = workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 1 })
  backend.commit(workspace, [])
  const received: BackendAction[] = []
  const stop = backend.start!({ dispatch: (actions) => received.push(...actions) })
  const commit = (actions: WorkspaceAction[]): Workspace => {
    workspace = actions.reduce(workspaceReducer, workspace)
    backend.commit(workspace, actions)
    return workspace
  }
  const target = (): WorkspaceTarget => ({
    projectId: activeProject(workspace)!.id,
    workspaceSessionId: activeSession(workspace)!.id,
  })
  const addTerminal = () => {
    const terminal = backend.newTerminal({
      number: activeSession(workspace)!.state.roster.nextNumber,
      directory: activeProject(workspace)!.directory,
    })
    commit([{ type: "terminal/add", target: target(), terminal }])
    return terminal
  }
  return { ...created, received, stop, commit, target, addTerminal, workspace: () => workspace }
}

// Shells that exit sooner than this count as failing to start.
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2_100))
const statusOf = (app: ReturnType<typeof open>, terminalId: string) =>
  app.received.flatMap((action) =>
    action.terminalId === terminalId && action.type === "terminal/status" ? [action] : [],
  )

describe("runner backend", () => {
  context("when the workspace changes", () => {
    it("saves the session so the next load restores names and order", async () => {
      const app = open()
      const first = app.addTerminal()
      const second = app.addTerminal()
      app.commit([
        { type: "terminal/rename", target: app.target(), terminalId: first.id, name: "server" },
        { type: "terminal/reorder", target: app.target(), tabOrder: [second.id, first.id] },
      ])
      await app.idle()
      app.stop()
      const reloaded = workspaceFromSeed(runnerSeed(await runner.reload()), {
        view: "focus",
        windowedView: "grid",
        now: 2,
      })
      const { roster } = activeSession(reloaded)!.state
      expect(roster.order).toEqual([second.id, first.id])
      const restored = roster.terminals.find((terminal) => terminal.id === first.id)
      expect(restored?.name).toBe("server")
      expect(restored?.state).not.toBe("starting")
    })

    it("creates a project opened from a folder, with its first session", async () => {
      const app = open()
      const project = { id: crypto.randomUUID(), name: "tmp", directory: process.cwd() }
      const session = {
        id: crypto.randomUUID(),
        name: "First",
        visitedAt: 3,
        state: createTerminalState([], "grid", "grid"),
      }
      app.commit([{ type: "project/add", project, activate: true, initialSession: session }])
      const terminal = app.addTerminal()
      await app.idle()
      app.stop()
      expect(await runner.client.projects.list()).toContainEqual({
        id: project.id,
        name: "tmp",
        cwd: process.cwd(),
      })
      const [listed] = await runner.client.terminals.list({ sessionId: session.id })
      expect(listed).toMatchObject({ id: terminal.id, exit: null })
    })
  })

  context("when the workspace reloads after a session change", () => {
    const reopened = async () =>
      workspaceFromSeed(runnerSeed(await runner.reload()), {
        view: "grid",
        windowedView: "grid",
        now: 0,
      })

    it("opens a fresh session started last, then the session switched back to", async () => {
      const app = open()
      const now = Date.now()
      const previous = activeSession(app.workspace())!.id
      const fresh = {
        id: crypto.randomUUID(),
        name: "Fresh",
        visitedAt: now,
        state: createTerminalState([], "grid", "grid"),
      }
      app.commit([{ type: "session/add", projectId: app.target().projectId, session: fresh }])
      await app.idle()
      expect(activeSession(await reopened())!.id).toBe(fresh.id)
      app.commit([
        {
          type: "session/select",
          projectId: app.target().projectId,
          workspaceSessionId: previous,
          now,
        },
      ])
      await app.idle()
      app.stop()
      expect(activeSession(await reopened())!.id).toBe(previous)
    })
  })

  context("when the person leaves a session and the app reloads", () => {
    it("restores its exact layouts, names, order and view, and each project's session", async () => {
      const app = open()
      // A session of its own, so no other test's terminals join it.
      app.commit([
        {
          type: "session/add",
          projectId: app.target().projectId,
          session: {
            id: crypto.randomUUID(),
            name: "Layout",
            visitedAt: Date.now(),
            state: createTerminalState([], "grid", "grid"),
          },
        },
      ])
      const [first, second] = [app.addTerminal(), app.addTerminal()]
      const target = app.target()
      app.commit([
        { type: "terminal/rename", target, terminalId: first.id, name: "api" },
        { type: "terminal/reorder", target, tabOrder: [second.id, first.id] },
        {
          type: "canvas/layout",
          target,
          layout: (layout) => ({
            ...layout,
            viewport: { x: -120, y: 40, zoom: 0.8 },
            minimized: { [second.id]: true },
            geometry: {
              ...layout.geometry,
              [first.id]: { position: { x: 310, y: 95 }, width: 640, height: 420 },
            },
          }),
        },
        {
          type: "terminal/size-preset",
          target,
          terminalId: first.id,
          view: "grid",
          preset: "large",
        },
        { type: "terminal/visibility", target, terminalId: second.id, hidden: true },
        { type: "grid/minimize", target, terminalId: first.id },
        {
          type: "view/change",
          target,
          view: "canvas",
          enabledViews: ["focus", "grid", "canvas"],
        },
      ])
      const left = activeSession(app.workspace())!
      const other = {
        id: crypto.randomUUID(),
        name: "elsewhere",
        directory: process.cwd(),
      }
      const otherSession = {
        id: crypto.randomUUID(),
        name: "Other",
        visitedAt: Date.now() + 10_000,
        state: createTerminalState([], "grid", "grid"),
      }
      app.commit([
        { type: "project/add", project: other, activate: true, initialSession: otherSession },
      ])
      await app.idle()
      app.stop()
      const reloaded = workspaceFromSeed(runnerSeed(await runner.reload()), {
        view: "focus",
        windowedView: "grid",
        now: 0,
      })
      expect(reloaded.activeProjectId).toBe(other.id)
      const home = reloaded.projects.find((project) => project.id === target.projectId)!
      expect(home.activeSessionId).toBe(left.id)
      const restored = home.history.find((session) => session.id === left.id)!.state
      expect(restored.layout).toEqual(left.state.layout)
      expect(restored).toMatchObject({
        view: "canvas",
        windowedView: left.state.windowedView,
        selected: left.state.selected,
      })
      expect(restored.roster.order).toEqual([second.id, first.id])
      expect(restored.roster.terminals.map(({ id, name }) => ({ id, name }))).toEqual(
        left.state.roster.terminals.map(({ id, name }) => ({ id, name })),
      )
      expect(
        reloaded.projects.find((project) => project.id === other.id)!.history.map(({ id }) => id),
      ).toEqual([otherSession.id])
    })
  })

  context("when the person moved on to another session", () => {
    it.skipIf(process.platform !== "linux")(
      "keeps the left session's shells running and reports what they run",
      async () => {
        const app = open()
        const terminal = app.addTerminal()
        const left = app.target()
        app.commit([
          {
            type: "session/add",
            projectId: left.projectId,
            session: {
              id: crypto.randomUUID(),
              name: "Next",
              visitedAt: Date.now(),
              state: createTerminalState([], "grid", "grid"),
            },
          },
        ])
        await app.idle()
        await typeInto(runner.client, terminal.id, "title vim\r")
        await vi.waitFor(
          () =>
            expect(app.received).toContainEqual({
              type: "terminal/status",
              target: left,
              terminalId: terminal.id,
              status: { state: "running" },
            }),
          eventually,
        )
        app.stop()
      },
    )
  })

  context("when the link drops", () => {
    it("creates and closes terminals once the runner is back", async () => {
      const app = open()
      await app.idle()
      await runner.drop()
      const terminal = app.addTerminal()
      await app.idle()
      const listed = await runner.client.terminals.list({
        sessionId: app.target().workspaceSessionId,
      })
      expect(listed.find((item) => item.id === terminal.id)?.exit).toBeNull()
      expect(app.received.filter((action) => action.terminalId === terminal.id)).not.toContainEqual(
        expect.objectContaining({ status: expect.objectContaining({ state: "failed" }) }),
      )
      await runner.drop()
      app.commit([{ type: "terminal/close", target: app.target(), terminalId: terminal.id }])
      await app.idle()
      app.stop()
      const after = await runner.client.terminals.list({
        sessionId: app.target().workspaceSessionId,
      })
      expect(after.map((item) => item.id)).not.toContain(terminal.id)
    })
  })

  context("when the UI closes a terminal", () => {
    it("ends its shell and the runner forgets it", async () => {
      const app = open()
      const terminal = app.addTerminal()
      await app.idle()
      app.commit([{ type: "terminal/close", target: app.target(), terminalId: terminal.id }])
      await app.idle()
      app.stop()
      await vi.waitFor(async () => {
        const listed = await runner.client.terminals.list({
          sessionId: app.target().workspaceSessionId,
        })
        // The runner forgets a terminal closed on purpose, so a reload cannot bring it back.
        expect(listed.map((item) => item.id)).not.toContain(terminal.id)
      })
    })
  })

  context("when the app quits", () => {
    it.skipIf(process.platform !== "linux")(
      "saves the program in the foreground before the host ends the shells",
      async () => {
        const quits: (() => Promise<void>)[] = []
        const app = open(runner.listing, {
          // Only the save before quitting may send the change.
          saveDelay: 60_000,
          beforeQuit: (save) => {
            quits.push(save)
            return () => void quits.splice(quits.indexOf(save), 1)
          },
        })
        const terminal = app.addTerminal()
        await app.idle()
        await typeInto(runner.client, terminal.id, "title claude\r")
        await vi.waitFor(
          () => expect(app.received).toContainEqual(expect.objectContaining({ process: "claude" })),
          eventually,
        )
        app.commit([...app.received])
        await quits[0]!()
        const saved = (await runner.reload())
          .flatMap(({ sessions }) => sessions)
          .map(({ session }) => decodeSession(session.state))
          .flatMap((session) => session?.state.roster.terminals ?? [])
          .find((item) => item.id === terminal.id)
        expect(saved?.lastProcess).toBe("claude")
        app.stop()
        expect(quits).toEqual([])
      },
    )
  })

  context("when the runner reports on a terminal", () => {
    it.skipIf(process.platform !== "linux")(
      "reports the foreground program, then the exit code",
      async () => {
        const app = open()
        const terminal = app.addTerminal()
        await app.idle()
        const { terminalId, ...target } = { ...app.target(), terminalId: terminal.id }
        await typeInto(runner.client, terminal.id, "title claude\r")
        await vi.waitFor(
          () =>
            expect(app.received).toContainEqual({
              type: "terminal/process",
              target,
              terminalId,
              process: "claude",
            }),
          eventually,
        )
        expect(app.received).toContainEqual({
          type: "terminal/status",
          target,
          terminalId,
          status: { state: "running" },
        })
        await settled()
        await typeInto(runner.client, terminal.id, "exit 2\r")
        await vi.waitFor(
          () =>
            expect(app.received).toContainEqual({
              type: "terminal/status",
              target,
              terminalId,
              status: { state: "exited", exitCode: 2, signal: null },
            }),
          eventually,
        )
        app.stop()
      },
    )

    it.skipIf(process.platform === "win32")("names the signal that killed the shell", async () => {
      const app = open()
      const terminal = app.addTerminal()
      await app.idle()
      await settled()
      await typeInto(runner.client, terminal.id, "kill SIGKILL\r")
      await vi.waitFor(
        () =>
          expect(statusOf(app, terminal.id).at(-1)).toMatchObject({
            status: { state: "exited", exitCode: null, signal: "SIGKILL" },
          }),
        eventually,
      )
      app.stop()
    })

    it("counts a shell that exits at once with an error as failing to start", async () => {
      const app = open()
      const terminal = app.addTerminal()
      await app.idle()
      await typeInto(runner.client, terminal.id, "exit 5\r")
      await vi.waitFor(
        () =>
          expect(statusOf(app, terminal.id).at(-1)).toMatchObject({
            status: { state: "failed", message: "Exited right after starting" },
          }),
        eventually,
      )
      app.stop()
    })

    it("closes the terminal of a shell that exited cleanly", async () => {
      const app = open()
      const terminal = app.addTerminal()
      await app.idle()
      await typeInto(runner.client, terminal.id, "exit 0\r")
      await vi.waitFor(
        () =>
          expect(app.received).toContainEqual({
            type: "terminal/close",
            target: app.target(),
            terminalId: terminal.id,
          }),
        eventually,
      )
      app.stop()
    })

    it("starts a fresh shell in the same terminal when asked to restart", async () => {
      const app = open()
      const terminal = app.addTerminal()
      await app.idle()
      const key = { ...app.target(), terminalId: terminal.id }
      await typeInto(runner.client, terminal.id, "exit 5\r")
      await vi.waitFor(
        () => expect(statusOf(app, terminal.id).at(-1)?.status.state).toBe("failed"),
        eventually,
      )
      app.restart(key)
      await app.idle()
      const listed = await runner.client.terminals.list({ sessionId: key.workspaceSessionId })
      expect(listed.find((item) => item.id === terminal.id)?.exit).toBeNull()
      // Alive again: "running" where the runner can name the foreground program, and
      // "idle" on Windows, where it cannot.
      await vi.waitFor(
        () =>
          expect(["running", "idle"]).toContain(statusOf(app, terminal.id).at(-1)?.status.state),
        eventually,
      )
      app.stop()
    })
  })

  context("when many saved terminals come back at once", () => {
    it("starts a fresh shell for every one of them", async () => {
      const [home] = runner.listing
      const projectId = home!.project.id
      const id = crypto.randomUUID()
      const terminals = Array.from({ length: 40 }, (_, index) =>
        startingTerminal(crypto.randomUUID(), index + 1, home!.project.cwd),
      )
      await runner.client.sessions.create({ id, projectId, name: "many" })
      await runner.client.sessions.save({
        sessionId: id,
        state: encodeSession(
          {
            id,
            name: "many",
            visitedAt: Date.now() + 200_000,
            state: createTerminalState(terminals, "grid", "grid"),
          },
          2,
        ),
      })
      const app = open(await runner.reload())
      expect(activeSession(app.workspace())!.id).toBe(id)
      await app.idle()
      const listed = await runner.client.terminals.list({ sessionId: id })
      expect(listed.filter((terminal) => terminal.exit === null)).toHaveLength(40)
      expect(
        app.received.filter((action) => "status" in action && action.status.state === "failed"),
      ).toEqual([])
      app.stop()
    }, 60_000)
  })

  context("when a shell exited cleanly while the app was away", () => {
    it("closes what the runner kept of it", async () => {
      const [home] = runner.listing
      const projectId = home!.project.id
      const id = crypto.randomUUID()
      const done = startingTerminal(crypto.randomUUID(), 1, home!.project.cwd)
      await runner.client.sessions.create({ id, projectId, name: "away" })
      await runner.client.terminals.create({ id: done.id, sessionId: id, cols: 80, rows: 24 })
      await runner.client.sessions.save({
        sessionId: id,
        state: encodeSession(
          {
            id,
            name: "away",
            visitedAt: 1,
            state: { ...createTerminalState([done], "grid", "grid"), selected: done.id },
          },
          0,
        ),
      })
      await typeInto(runner.client, done.id, "exit 0\r")
      await vi.waitFor(async () => {
        const [listed] = await runner.client.terminals.list({ sessionId: id })
        expect(listed?.exit).toBeTruthy()
      }, eventually)
      const app = open(await runner.reload())
      const session = app
        .workspace()
        .projects.flatMap((project) => project.history)
        .find((item) => item.id === id)!
      expect(session.state.roster.terminals).toEqual([])
      expect(session.state.selected).toBe("")
      await app.idle()
      expect(await runner.client.terminals.list({ sessionId: id })).toEqual([])
      app.stop()
    })
  })

  context("while the app boots", () => {
    it("counts the restored session's terminals as they come back", async () => {
      const [home] = runner.listing
      const projectId = home!.project.id
      const id = crypto.randomUUID()
      const terminals = Array.from({ length: 3 }, (_, index) =>
        startingTerminal(crypto.randomUUID(), index + 1, home!.project.cwd),
      )
      await runner.client.sessions.create({ id, projectId, name: "boot" })
      await runner.client.sessions.save({
        sessionId: id,
        state: encodeSession(
          {
            id,
            name: "boot",
            visitedAt: Date.now() + 600_000,
            state: createTerminalState(terminals, "grid", "grid"),
          },
          2,
        ),
      })
      const app = open(await runner.reload())
      expect(activeSession(app.workspace())!.id).toBe(id)
      expect(app.backend.boot?.getSnapshot()).toMatchObject({ total: 3, done: false })
      await vi.waitFor(
        () =>
          expect(app.backend.boot?.getSnapshot()).toEqual({ attached: 3, total: 3, done: true }),
        eventually,
      )
      app.stop()
    })
  })

  context("after a terminal restarts", () => {
    it.skipIf(process.platform !== "linux")(
      "reports what its fresh shell runs, and a kill right away as killed",
      async () => {
        const app = open()
        const terminal = app.addTerminal()
        await app.idle()
        const key = { ...app.target(), terminalId: terminal.id }
        const { terminalId, ...target } = key
        await typeInto(runner.client, terminal.id, "exit 5\r")
        await vi.waitFor(
          () => expect(statusOf(app, terminalId).at(-1)?.status.state).toBe("failed"),
          eventually,
        )
        app.restart(key)
        await app.idle()
        await typeInto(runner.client, terminalId, "title claude\r")
        await vi.waitFor(() => {
          expect(app.received).toContainEqual({
            type: "terminal/process",
            target,
            terminalId,
            process: "claude",
          })
          expect(statusOf(app, terminalId).at(-1)?.status).toEqual({ state: "running" })
        }, eventually)
        await typeInto(runner.client, terminalId, "kill SIGKILL\r")
        await vi.waitFor(
          () =>
            expect(statusOf(app, terminalId).at(-1)?.status).toEqual({
              state: "exited",
              exitCode: null,
              signal: "SIGKILL",
            }),
          eventually,
        )
        app.stop()
      },
    )
  })

  context("when the runner no longer has a terminal", () => {
    const listed = async (sessionId: string, terminalId: string) =>
      (await runner.client.terminals.list({ sessionId })).find((item) => item.id === terminalId)

    it("keeps a terminal another client closed until asked to restart it", async () => {
      const app = open()
      const terminal = app.addTerminal()
      await app.idle()
      const key = { ...app.target(), terminalId: terminal.id }
      await runner.client.terminals.close(terminal.id)
      await vi.waitFor(async () => {
        const last = app.received.findLast(
          (action) => action.terminalId === terminal.id && action.type === "terminal/status",
        )
        expect(last && "status" in last && last.status.state).toMatch(/exited|failed/)
      }, eventually)
      expect(await listed(key.workspaceSessionId, terminal.id)).toBeUndefined()
      app.restart(key)
      await app.idle()
      expect((await listed(key.workspaceSessionId, terminal.id))?.exit).toBeNull()
      app.stop()
    })

    it("starts one for a terminal a listing leaves out, as after a runner restart", async () => {
      const [home] = runner.listing
      const { session } = home!.sessions[0]!
      const lost = crypto.randomUUID()
      const listing: RunnerListing = [
        {
          project: home!.project,
          sessions: [
            {
              session,
              terminals: [
                {
                  id: lost,
                  sessionId: session.id,
                  cwd: home!.project.cwd,
                  cols: 80,
                  rows: 24,
                  exit: null,
                  run: 1,
                  process: { name: "zsh", argv: null },
                  agent: null,
                },
              ],
            },
          ],
        },
      ]
      const app = open(listing)
      await vi.waitFor(async () => {
        await app.idle()
        expect((await listed(session.id, lost))?.exit).toBeNull()
      }, eventually)
      app.stop()
    })

    it("restores saved terminals only once their session is on screen", async () => {
      const [home] = runner.listing
      const projectId = home!.project.id
      const saved = (id: string, terminalId: string, visitedAt: number) =>
        encodeSession(
          {
            id,
            name: id,
            visitedAt,
            state: createTerminalState(
              [{ ...startingTerminal(terminalId, 1, home!.project.cwd), name: "kept" }],
              "grid",
              "grid",
            ),
          },
          0,
        )
      const [shown, later] = [crypto.randomUUID(), crypto.randomUUID()]
      const [first, second] = [crypto.randomUUID(), crypto.randomUUID()]
      const seeded: readonly (readonly [string, string, number])[] = [
        // Later than any other test's session, so this one opens.
        [shown, first, Date.now() + 1_000_000],
        [later, second, Date.now() + 500_000],
      ]
      await Promise.all(
        seeded.map(async ([id, terminalId, visitedAt]) => {
          await runner.client.sessions.create({ id, projectId, name: id })
          await runner.client.sessions.save({
            sessionId: id,
            state: saved(id, terminalId, visitedAt),
          })
        }),
      )
      const app = open(await runner.reload())
      expect(activeSession(app.workspace())!.id).toBe(shown)
      await vi.waitFor(async () => {
        await app.idle()
        expect((await listed(shown, first))?.exit).toBeNull()
      }, eventually)
      expect(await listed(later, second)).toBeUndefined()
      app.commit([
        {
          type: "session/select",
          projectId,
          workspaceSessionId: later,
          now: Date.now() + 2_000_000,
        },
      ])
      await app.idle()
      expect((await listed(later, second))?.exit).toBeNull()
      const name = activeSession(app.workspace())!.state.roster.terminals[0]!.name
      expect(name).toBe("kept")
      app.stop()
    })
  })
})
