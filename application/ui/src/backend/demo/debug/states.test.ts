import { afterEach, beforeEach, vi } from "vitest"

import { workspaceFromSeed } from "../../../model/seed"
import { workspaceReducer } from "../../../model/state"
import { terminalPhase } from "../../../model/terminal-ending"
import type { Workspace } from "../../../model/types"
import { context, describe, expect, it } from "../../../test"
import type { BackendAction, TerminalKey } from "../../port"
import { createMockTerminal, demoSeed } from "../samples"
import { createDemoStates } from "./states"
import type { DemoActionContext } from "./types"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const initial = workspaceFromSeed(demoSeed(0), { view: "focus", windowedView: "grid", now: 0 })
const project = initial.projects[0]!
const session = project.history[0]!
const key = (terminalId: string): TerminalKey => ({
  projectId: project.id,
  workspaceSessionId: session.id,
  terminalId,
})

// A panel over a real reducer, with the selected terminal as given.
const panel = (selected: string | undefined) => {
  let workspace: Workspace = initial
  const notes: string[] = []
  const added: TerminalKey[] = []
  const actionContext: DemoActionContext = {
    selected: () => (selected ? key(selected) : undefined),
    addTerminal: () => {
      const number = 90 + added.length
      const created = key(String(number))
      added.push(created)
      workspace = workspaceReducer(workspace, {
        type: "terminal/add",
        target: { projectId: project.id, workspaceSessionId: session.id },
        terminal: createMockTerminal(number, "~"),
      })
      return created
    },
    startFresh: () => {},
    dispatch: (actions: readonly BackendAction[]) => {
      workspace = actions.reduce(workspaceReducer, workspace)
    },
    workspace: () => workspace,
    note: (text) => void notes.push(text),
  }
  const states = createDemoStates()
  const find = (label: string) =>
    states.groups.flatMap((group) => group.actions).find((action) => action.label === label)!
  const terminal = (id: string) =>
    workspace.projects[0]!.history[0]!.state.roster.terminals.find((each) => each.id === id)
  return {
    states,
    actionContext,
    notes,
    added,
    find,
    terminal,
    run: (label: string) => find(label).run(actionContext),
  }
}

describe("demo states", () => {
  it("puts each of its new terminals in its own state, the finished ones first", async () => {
    const { run, added, terminal } = panel("04")
    await run("Every state at once")
    const shown = added.map((each) => terminal(each.terminalId)!)
    expect(shown.map((each) => each.name)).toContain("Needs permission")
    expect(shown.at(-1)).toMatchObject({
      name: "Needs permission",
      agent: { attention: { kind: "permission", count: 1 } },
    })
    expect(shown[0]).toMatchObject({
      name: "Finished turn",
      agent: { lastTurn: { outcome: "completed" } },
    })
    expect(shown[1]).toMatchObject({ agent: { lastTurn: { outcome: "failed" } } })
    expect(new Set(shown.map((each) => terminalPhase(each)))).toEqual(
      new Set(["idle", "running", "attention", "unheard", "starting", "ended"]),
    )
  })

  it("groups its actions, each with a hint", () => {
    const { states } = panel("04")
    expect(states.groups.map((group) => group.title)).toEqual([
      "All at once",
      "Selected terminal",
      "Agent",
      "Another project",
      "New terminals",
      "Notices",
      "Agents",
      "Chat",
      "Folders",
    ])
    for (const action of states.groups.flatMap((group) => group.actions))
      expect(action.hint).not.toBe("")
  })

  context("in another project", () => {
    it("acts on its first terminal, not the one on screen", async () => {
      const { states, actionContext, terminal } = panel("04")
      const group = states.groups.find((each) => each.title === "Another project")!
      const action = (label: string) => group.actions.find((each) => each.label === label)!
      const other = initial.projects[1]!
      const otherTerminal = () =>
        actionContext
          .workspace()!
          .projects[1]!.history.find((each) => each.id === other.activeSessionId)!.state.roster
          .terminals[0]!
      expect(other.id).not.toBe(project.id)

      await action("Needs permission").run(actionContext)
      expect(otherTerminal()).toMatchObject({ agent: { attention: { kind: "permission" } } })
      expect(terminal("04")).not.toHaveProperty("agent")

      await action("Turn completed").run(actionContext)
      vi.runAllTimers()
      expect(otherTerminal()).toMatchObject({ agent: { lastTurn: { outcome: "completed" } } })
    })
  })

  context("with no terminal selected", () => {
    it("asks for one instead of acting", () => {
      const { run, notes, terminal } = panel(undefined)
      run("Exited · code 3")
      run("Working")
      expect(notes).toEqual(["Select a terminal first.", "Select a terminal first."])
      expect(terminal("04")).toMatchObject({ state: "running", process: "zsh" })
    })
  })

  context("with a terminal selected", () => {
    it("ends its shell as the action says", () => {
      const { run, terminal } = panel("04")
      run("Killed · SIGKILL")
      expect(terminal("04")).toMatchObject({ state: "exited", signal: "SIGKILL" })
    })

    it("makes it an agent, working", () => {
      const { run, terminal } = panel("04")
      run("Working")
      expect(terminal("04")).toMatchObject({ process: "claude", agent: { working: true } })
    })

    it("ends an agent's turn after it works", () => {
      const { run, terminal } = panel("04")
      run("Turn failed")
      expect(terminal("04")).toMatchObject({ agent: { working: true } })
      vi.advanceTimersByTime(3000)
      expect(terminal("04")).toMatchObject({ agent: { lastTurn: { outcome: "failed" } } })
    })

    it("leaves a turn unended once the terminal is back at its shell", () => {
      const { run, terminal } = panel("04")
      run("Turn completed")
      run("Back at the prompt")
      vi.advanceTimersByTime(3000)
      expect(terminal("04")).toMatchObject({ process: "zsh", state: "idle" })
      expect(terminal("04")).not.toHaveProperty("agent")
    })

    it("lets an unheard agent say nothing", () => {
      const { run, terminal } = panel("04")
      run("Unheard agent")
      expect(terminalPhase(terminal("04")!)).toBe("unheard")
    })
  })

  context("when an agent finishes elsewhere", () => {
    it("ends the turn of another terminal, not the selected one", () => {
      const { run, terminal } = panel("04")
      run("Agent finishes elsewhere")
      const other = ["01", "02", "03", "05", "06"].find((id) => terminal(id)?.process === "claude")!
      expect(other).toBeDefined()
      vi.advanceTimersByTime(3000)
      expect(terminal(other)).toMatchObject({ agent: { lastTurn: { outcome: "completed" } } })
      expect(terminal("04")?.process).toBe("zsh")
    })
  })

  context("when new terminals fail", () => {
    it("adds one that fails right after starting", () => {
      const { run, added, terminal } = panel("04")
      run("Quick failure")
      expect(added).toHaveLength(1)
      const id = added[0]!.terminalId
      expect(terminal(id)?.state).toBe("starting")
      vi.advanceTimersByTime(400)
      expect(terminal(id)).toMatchObject({
        state: "failed",
        message: "Exited right after starting",
      })
    })

    it("adds thirty at once", () => {
      const { run, added } = panel("04")
      run("Burst of 30")
      expect(added).toHaveLength(30)
    })
  })

  it("restarts an ended terminal with a fresh shell", () => {
    const { states, run, actionContext, terminal } = panel("04")
    run("Exited · code 3")
    states.restart(key("04"), actionContext.dispatch!)
    expect(terminal("04")).toMatchObject({ state: "idle", process: "zsh" })
  })
})
