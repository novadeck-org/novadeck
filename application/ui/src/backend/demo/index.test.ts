import { workspaceFromSeed } from "../../model/seed"
import { activeProject, activeSession, workspaceReducer } from "../../model/state"
import { context, describe, expect, it } from "../../test"
import { createDemoEngine } from "./engine"
import { demoBackend } from "./index"

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
})
