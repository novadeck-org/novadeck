import { workspaceFromSeed } from "../../model/seed"
import { activeProject, activeSession, workspaceReducer } from "../../model/state"
import { context, describe, expect, it } from "../../test"
import { itemFixture } from "../../test/fixtures"
import type { BackendAction } from "../port"
import { createDemoEngine } from "./engine"
import { demoBackend, withMessages } from "./index"

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
      expect([first.name, second.name]).toEqual([
        `Terminal ${String(seeded + 1).padStart(2, "0")}`,
        `Terminal ${String(seeded + 2).padStart(2, "0")}`,
      ])
      expect(backend.newTerminal({ target, directory: "~", title: "Agent" }).name).toBe("Agent")
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
          window: { id: "w1", itemId: item.id, name: "hero.png", titleSource: { kind: "default" } },
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
          window: { id: "w1", itemId: item.id, name: "hero.png", titleSource: { kind: "default" } },
        },
      ])
    })
  })
})
