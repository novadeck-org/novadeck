import type { BackendAction } from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { activeProject, activeSession, workspaceReducer } from "@novadeck/core/state"
import { itemFixture } from "@novadeck/core/testing"

import { createDemoEngine } from "./engine"
import { demoHandle } from "./handles"
import { demoBackend, withMessages } from "./index"
import { createMockTerminal, defaultName } from "./samples"
import { context, describe, expect, it } from "./test"
import { demoTurns } from "./turns"
import { createDemo, demoVariants } from "./variants"

describe("demo backend", () => {
  context("standing in for the runner", () => {
    it("numbers each session's new terminals itself, never twice, or names them as asked", () => {
      const backend = demoBackend(createDemoEngine())
      let workspace = workspaceFromSeed(backend.seed, {
        view: "grid",
        windowedView: "grid",
        now: 1,
      })
      backend.commit(workspace, [])
      const target = {
        projectId: activeProject(workspace)!.id,
        workspaceSessionId: activeSession(workspace)!.id,
      }
      const seeded = activeSession(workspace)!.state.roster.terminals.length
      const first = backend.newTerminal({ target, directory: "~" })
      const add = { type: "terminal/add", target, terminal: first } as const
      workspace = workspaceReducer(workspace, add)
      backend.commit(workspace, [add])
      const close = { type: "terminal/close", target, terminalId: first.id } as const
      workspace = workspaceReducer(workspace, close)
      backend.commit(workspace, [close])
      const second = backend.newTerminal({ target, directory: "~" })
      // Both are plain shells, named as the runner names one; the number each took shows
      // in its handle, which the sixth and seventh words give.
      expect([first.name, second.name]).toEqual(["Terminal", "Terminal"])
      expect([first.handle, second.handle]).toEqual([
        demoHandle(seeded + 1),
        demoHandle(seeded + 2),
      ])
      expect(first.id).not.toBe(second.id)
      expect(backend.newTerminal({ target, directory: "~", title: "Agent" }).name).toBe("Agent")
      // One opened to run a program is named after it.
      expect(
        backend.newTerminal({ target, directory: "~", launch: { command: "claude --resume" } })
          .name,
      ).toBe("claude")
    })
  })

  context("when a terminal is named again by default", () => {
    it("takes the program it was opened to run, else Terminal", () => {
      const target = { projectId: "p", workspaceSessionId: "s" }
      const named = (command?: string) =>
        defaultName(createMockTerminal(target, 7, "~", command).command)
      expect([named(), named("claude --resume")]).toEqual(["Terminal", "claude"])
    })
  })

  context("when terminals close and projects are removed", () => {
    it("never reuses a live terminal's ID", () => {
      const backend = demoBackend(createDemoEngine())
      let workspace = workspaceFromSeed(backend.seed, {
        view: "grid",
        windowedView: "grid",
        now: 1,
      })
      backend.commit(workspace, [])
      const [first, second] = workspace.projects
      const target = { projectId: second!.id, workspaceSessionId: second!.history[0]!.id }
      const liveIds = () =>
        workspace.projects.flatMap((project) =>
          project.history.flatMap((session) =>
            session.state.roster.terminals.map((terminal) => terminal.id),
          ),
        )
      const apply = (action: Parameters<typeof workspaceReducer>[1]) => {
        workspace = workspaceReducer(workspace, action)
        backend.commit(workspace, [])
      }
      const addTerminal = () => {
        const terminal = backend.newTerminal({ target, directory: "~" })
        expect(liveIds()).not.toContain(terminal.id)
        apply({ type: "terminal/add", target, terminal })
      }
      const closeTerminal = (index: number) =>
        apply({
          type: "terminal/close",
          target,
          terminalId: workspace.projects.find((project) => project.id === target.projectId)!
            .history[0]!.state.roster.terminals[index]!.id,
        })
      closeTerminal(2)
      addTerminal()
      apply({ type: "project/remove", projectId: first!.id, now: 2 })
      closeTerminal(2)
      addTerminal()
      addTerminal()
    })
  })

  context("in every demo", () => {
    it.each(demoVariants)(
      "keeps each terminal's ID unique across the workspace in %s, as the runner's are",
      (variant) => {
        const backend = createDemo(variant)
        backend.commit(
          workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 1 }),
          [],
        )
        const ids = backend.seed.projects.flatMap((project) =>
          project.sessions.flatMap((session) => session.terminals.map((terminal) => terminal.id)),
        )
        for (const project of backend.seed.projects)
          for (const session of project.sessions) {
            const target = { projectId: project.id, workspaceSessionId: session.id }
            for (const _ of [1, 2]) ids.push(backend.newTerminal({ target, directory: "~" }).id)
          }
        expect(ids.length).toBeGreaterThan(backend.seed.projects.length)
        expect(new Set(ids).size).toBe(ids.length)
        // IDs appear in `?terminal=` deep links.
        for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
      },
    )
  })

  context("with the turns of the debug panel", () => {
    it.each(demoVariants)("reports every agent status of %s through them", (variant) => {
      const turns = demoTurns()
      const backend = createDemo(variant, undefined, turns)
      const reported: BackendAction[] = []
      const stop = backend.start!({
        dispatch: (actions) => reported.push(...actions),
        open: () => {},
      })
      const terminal = backend.seed.projects[0]!.sessions[0]!.terminals[0]!
      const key = {
        projectId: backend.seed.projects[0]!.id,
        workspaceSessionId: backend.seed.projects[0]!.sessions[0]!.id,
        terminalId: terminal.id,
      }
      turns.rest(key, terminal)
      expect(reported.at(-1)).toMatchObject({
        type: "terminal/status",
        terminalId: terminal.id,
        status: { state: "running", agent: { working: false } },
      })
      stop()
    })
  })

  context("with the agents' usage in the telemetry", () => {
    const opened = () => {
      const backend = createDemo("agents", undefined, demoTurns())
      const workspace = workspaceFromSeed(backend.seed, {
        view: "grid",
        windowedView: "grid",
        now: 1,
      })
      backend.commit(workspace, [])
      return { backend, workspace }
    }

    it("forgets a closed terminal's usage", () => {
      const { backend, workspace } = opened()
      const target = { projectId: "storefront", workspaceSessionId: "initial" }
      const [terminalId] = Object.keys(backend.telemetry.getSnapshot()["storefront/initial"]!)
      const action = { type: "terminal/close" as const, target, terminalId: terminalId! }
      backend.commit(workspaceReducer(workspace, action), [action])
      expect(backend.telemetry.getSnapshot()["storefront/initial"]).not.toHaveProperty(terminalId!)
    })

    it("forgets a removed project's usage, and only that project's", () => {
      const { backend, workspace } = opened()
      expect(Object.keys(backend.telemetry.getSnapshot())).toEqual([
        "storefront/initial",
        "api-service/initial",
      ])
      const action = { type: "project/remove" as const, projectId: "storefront", now: 2 }
      backend.commit(workspaceReducer(workspace, action), [action])
      expect(Object.keys(backend.telemetry.getSnapshot())).toEqual(["api-service/initial"])
    })
  })

  context("when a window's name is handed back", () => {
    it("names the window after what it shows again", () => {
      const backend = withMessages(demoBackend(createDemoEngine()), 1)
      let workspace = workspaceFromSeed(backend.seed, {
        view: "grid",
        windowedView: "grid",
        now: 1,
      })
      const target = {
        projectId: activeProject(workspace)!.id,
        workspaceSessionId: activeSession(workspace)!.id,
      }
      const item = itemFixture("hero", "01", { name: "hero.png" })
      const undocked = [
        { type: "item/upsert", target, item },
        {
          type: "item/undock",
          target,
          itemId: item.id,
          window: {
            id: "w1",
            home: "undocked",
            itemId: item.id,
            name: "hero.png",
            titleSource: { kind: "default" },
          },
        },
        { type: "terminal/rename", target, terminalId: "w1", name: "Mine" },
      ] as const
      workspace = undocked.reduce(workspaceReducer, workspace)
      backend.commit(workspace, undocked)
      const reported: BackendAction[] = []
      const stop = backend.start!({
        dispatch: (actions) => reported.push(...actions),
        open: () => {},
      })
      backend.resetTitle!({ ...target, terminalId: "w1" })
      stop()
      expect(reported).toEqual([
        {
          type: "window/upsert",
          target,
          window: {
            id: "w1",
            home: "undocked",
            itemId: item.id,
            name: "hero.png",
            titleSource: { kind: "default" },
          },
        },
      ])
    })
  })
})
