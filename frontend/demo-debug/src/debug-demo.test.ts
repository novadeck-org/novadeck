import type { TerminalKey } from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore } from "@novadeck/core/store"
import { terminalOf } from "@novadeck/demo/workspace"
import { noTheme } from "@novadeck/terminal-views/theme"
import { vi } from "vitest"

import { createBootRehearsals } from "./boot-rehearsal"
import { createDebugDemo, type DemoLaunch, type DemoShell } from "./debug-demo"
import { runProgram } from "./terminals"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

// What the demo's terminals were told: started or stopped.
const life = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock("@novadeck/demo", async (original) => {
  const index = await original<typeof import("@novadeck/demo")>()
  return {
    ...index,
    demoTerminalsLife: (...args: Parameters<typeof index.demoTerminalsLife>) => {
      const terminals = index.demoTerminalsLife(...args)
      return (
        terminals && {
          start: () => {
            life.calls.push("start")
            terminals.start()
          },
          stop: () => {
            life.calls.push("stop")
            terminals.stop()
          },
        }
      )
    },
  }
})

// The shell each debug demo hands its panel, the newest last.
const shells = vi.hoisted(() => [] as unknown[])
vi.mock("./DebugPanel", async (original) => {
  const panel = await original<typeof import("./DebugPanel")>()
  return {
    ...panel,
    createDebugPanel: (...args: Parameters<typeof panel.createDebugPanel>) => {
      shells.push(args[0].shell)
      return panel.createDebugPanel(...args)
    },
  }
})

const launch = (): DemoLaunch => ({
  rehearsals: createBootRehearsals(),
  theme: noTheme,
  variant: "plain",
  slowAttach: false,
  switchVariant: () => {},
  armSlowAttach: () => {},
  sandbox: undefined,
  setSandbox: () => {},
  portable: undefined,
  setPortable: () => {},
  bootInstalled: () => {},
  play: undefined,
  uninstall: undefined,
  setUninstall: () => {},
  worktrees: true,
  setWorktrees: () => {},
})

describe("the debug layer's demo", () => {
  it("starts its terminals with it, and stops them with it, so a reboot leaves none behind", () => {
    life.calls.length = 0
    const backend = createDebugDemo(launch())
    const stop = backend.start!({ dispatch: () => {}, open: () => {} })
    expect(life.calls).toEqual(["start"])
    stop()
    expect(life.calls).toEqual(["start", "stop"])
  })

  it("offers agent worktrees unless the launch says the backend has none", () => {
    expect(createDebugDemo(launch()).worktrees).toBeDefined()
    expect(createDebugDemo({ ...launch(), worktrees: false }).worktrees).toBeUndefined()
  })

  it("restarts the terminals of every session a crash loop failed, not only the last's", () => {
    const backend = createDebugDemo(launch())
    const shell = shells.at(-1) as DemoShell
    const workspace = createWorkspaceStore(
      workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 0 }),
      backend.commit,
    )
    backend.commit(workspace.getSnapshot(), [])
    backend.start!({ dispatch: (actions) => void workspace.transact(actions), open: () => {} })
    const sessions = workspace
      .getSnapshot()
      .projects.slice(0, 2)
      .map((project) => project.history.find((each) => each.id === project.activeSessionId)!)
    const firsts = workspace
      .getSnapshot()
      .projects.slice(0, 2)
      .map((project, index): TerminalKey => ({
        projectId: project.id,
        workspaceSessionId: sessions[index]!.id,
        terminalId: sessions[index]!.state.roster.terminals[0]!.id,
      }))
    expect(firsts).toHaveLength(2)
    for (const selected of firsts)
      shell.tripCrashLoop({
        selected: () => selected,
        workspace: () => workspace.getSnapshot(),
        dispatch: (actions) => void workspace.transact(actions),
        note: () => {},
      } as Partial<DemoActionContext> as DemoActionContext)
    const states = () =>
      workspace
        .getSnapshot()
        .projects.slice(0, 2)
        .flatMap((project) =>
          project.history
            .find((each) => each.id === project.activeSessionId)!
            .state.roster.terminals.map((terminal) => terminal.state),
        )
    expect(new Set(states())).toEqual(new Set(["failed"]))
    // One the person restarted by hand runs on, untouched by Restart terminals.
    const revived = firsts[0]!
    workspace.transact(runProgram(revived, "sleep"))
    backend.crashLoop!.retry()
    expect(states()).not.toContain("failed")
    expect(terminalOf(workspace.getSnapshot(), revived)).toMatchObject({
      state: "running",
      process: "sleep",
    })
  })
})
