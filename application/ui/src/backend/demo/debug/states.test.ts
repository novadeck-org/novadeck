import { afterEach, beforeEach, vi } from "vitest"

import { workspaceFromSeed } from "../../../model/seed"
import { workspaceReducer } from "../../../model/state"
import { createWorkspaceStore } from "../../../model/store"
import { terminalPhase } from "../../../model/terminal-ending"
import { context, describe, expect, it } from "../../../test"
import type { BackendAction, TerminalKey } from "../../port"
import { createMockTerminal, demoSeed, demoTerminalId, terminalSlot } from "../samples"
import { createDemoStates } from "./states"
import { backToPrompt, exitedWithCode, terminalOf } from "./terminals"
import type { DemoActionContext } from "./types"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const initial = workspaceFromSeed(demoSeed(0), { view: "focus", windowedView: "grid", now: 0 })
const project = initial.projects[0]!
const session = project.history[0]!
// A terminal of the first session by its number, as `"04"`.
const id = (slot: string): string =>
  demoTerminalId({ projectId: project.id, workspaceSessionId: session.id }, Number(slot))
const inSession = (terminalId: string): TerminalKey => ({
  projectId: project.id,
  workspaceSessionId: session.id,
  terminalId,
})
const key = (slot: string): TerminalKey => inSession(id(slot))

// A panel over a real workspace, with the terminal on screen as given. It records what the
// panel does that the app would take for a person's move: adding a terminal the way "+"
// does (which selects it and shows the Terminals panel), and an agent starting to work.
const panel = (selected: string | undefined, { keeping }: { keeping?: number } = {}) => {
  // `keeping` shrinks the workspace to that many terminals besides the selected one.
  const kept =
    keeping === undefined
      ? initial
      : initial.projects
          .flatMap((each) =>
            each.history.flatMap((owner) =>
              owner.state.roster.terminals.map((entry) => ({
                target: { projectId: each.id, workspaceSessionId: owner.id },
                terminalId: entry.id,
              })),
            ),
          )
          .filter(({ terminalId }) => terminalId !== (selected && id(selected)))
          .slice(keeping)
          .reduce(
            (left, { target, terminalId }) =>
              workspaceReducer(left, { type: "terminal/close", target, terminalId }),
            initial,
          )
  const workspace = createWorkspaceStore(kept)
  const target = { projectId: project.id, workspaceSessionId: session.id }
  if (selected) workspace.dispatch({ type: "terminal/select", target, terminalId: id(selected) })
  const notes: string[] = []
  const added: TerminalKey[] = []
  const plus: TerminalKey[] = []
  const worked = new Set<string>()
  const create = (select: boolean): TerminalKey => {
    const number = 90 + added.length
    const created = key(String(number))
    added.push(created)
    workspace.dispatch({
      type: "terminal/add",
      target,
      terminal: createMockTerminal(target, number, "~"),
      select,
    })
    return created
  }
  const onScreen = (): string | undefined =>
    workspace.getSnapshot().projects[0]!.history[0]!.state.selected
  const actionContext: DemoActionContext = {
    selected: () => (selected && onScreen() ? inSession(onScreen()!) : undefined),
    addTerminal: () => {
      const created = create(true)
      plus.push(created)
      return created
    },
    addInBackground: () => create(false),
    startFresh: () => {},
    dispatch: (actions: readonly BackendAction[]) => {
      for (const action of actions)
        if (action.type === "terminal/status" && action.status.state === "running") {
          const agent = action.status.agent
          if (agent?.working) worked.add(`${action.target.projectId}/${action.terminalId}`)
        }
      void workspace.transact(actions)
    },
    workspace: () => workspace.getSnapshot(),
    note: (text) => void notes.push(text),
  }
  const states = createDemoStates()
  const find = (label: string) =>
    states.groups.flatMap((group) => group.actions).find((action) => action.label === label)!
  const terminal = (slot: string) =>
    workspace
      .getSnapshot()
      .projects[0]!.history[0]!.state.roster.terminals.find((each) => each.id === id(slot))
  // What each terminal other than the one on screen asks of the person: its request, or an
  // agent that finished (which the app marks unread, as the person looks elsewhere).
  const asks = () =>
    workspace.getSnapshot().projects.flatMap((each) =>
      each.history.flatMap((owner) =>
        owner.state.roster.terminals.flatMap((entry) => {
          const agent = entry.state === "running" ? entry.agent : undefined
          const kind = agent?.attention?.kind ?? agent?.lastTurn?.outcome
          const looked =
            each.id === project.id && owner.id === session.id && entry.id === onScreen()
          return kind && !looked
            ? [{ projectId: each.id, sessionId: owner.id, terminalId: entry.id, kind }]
            : []
        }),
      ),
    )
  return {
    states,
    actionContext,
    notes,
    added,
    plus,
    worked,
    find,
    terminal,
    asks,
    onScreen,
    run: (label: string) => find(label).run(actionContext),
  }
}

describe("demo states", () => {
  it("puts each of its new terminals in its own state, the finished ones first", async () => {
    const { run, added, terminal } = panel("04")
    await run("Every state at once")
    const shown = added.map((each) => terminal(terminalSlot(each.terminalId))!)
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
      "Notification center",
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
      const other = ["01", "02", "03", "05", "06"].find(
        (slot) => terminal(slot)?.process === "claude",
      )!
      expect(other).toBeDefined()
      vi.advanceTimersByTime(3000)
      expect(terminal(other)).toMatchObject({ agent: { lastTurn: { outcome: "completed" } } })
      expect(terminal("04")?.process).toBe("zsh")
    })
  })

  context("with the notification center", () => {
    it("asks for the terminal on screen first", () => {
      const { run, notes } = panel(undefined)
      run("Fill the notification center")
      expect(notes).toEqual(["Select a terminal first."])
    })

    it("fills it with every kind, across projects, past the badge's cap", () => {
      const { run, asks } = panel("04")
      run("Fill the notification center")
      vi.advanceTimersByTime(3000)
      const all = asks()
      expect(all).toHaveLength(12)
      expect(new Set(all.map((each) => each.kind))).toEqual(
        new Set(["question", "permission", "plan", "failed", "completed"]),
      )
      expect(new Set(all.map((each) => each.projectId)).size).toBeGreaterThan(1)
      expect(
        all.some((each) => each.projectId === project.id && each.terminalId === id("04")),
      ).toBe(false)
    })

    it("adds what it needs without selecting it, so every finish lands elsewhere", () => {
      const { run, onScreen, plus, added, asks } = panel("04", { keeping: 3 })
      run("Fill the notification center")
      vi.advanceTimersByTime(3000)
      expect(added.length).toBeGreaterThan(0)
      // Not through the app's "+", which selects the terminal and shows the Terminals panel.
      expect(plus).toEqual([])
      expect(onScreen()).toBe(id("04"))
      expect(asks()).toHaveLength(12)
      for (const each of added)
        expect(asks().some((entry) => entry.terminalId === each.terminalId)).toBe(true)
    })

    it("does not bring back a terminal that ended before its finish", () => {
      const { run, actionContext, asks } = panel("04")
      run("Fill the notification center")
      const found = actionContext
        .workspace()!
        .projects.flatMap((each) =>
          each.history.flatMap((owner) =>
            owner.state.roster.terminals.map((entry) => ({
              key: { projectId: each.id, workspaceSessionId: owner.id, terminalId: entry.id },
              entry,
            })),
          ),
        )
        .find(
          ({ key: at, entry }) =>
            entry.state === "running" &&
            entry.agent?.working &&
            !entry.agent.attention &&
            at.terminalId !== id("04"),
        )!
      actionContext.dispatch!(exitedWithCode(found.key, 1))
      vi.advanceTimersByTime(3000)
      expect(terminalOf(actionContext.workspace(), found.key)?.state).toBe("exited")
      expect(
        asks().some(
          (each) =>
            each.projectId === found.key.projectId &&
            each.sessionId === found.key.workspaceSessionId &&
            each.terminalId === found.key.terminalId,
        ),
      ).toBe(false)
    })

    it("empties it again", () => {
      const { run, asks } = panel("04")
      run("Fill the notification center")
      vi.advanceTimersByTime(3000)
      expect(asks()).not.toEqual([])
      run("Clear notifications")
      vi.advanceTimersByTime(100)
      expect(asks()).toEqual([])
    })

    it("calls off the finishes still pending when cleared", () => {
      const { run, asks } = panel("04")
      run("Fill the notification center")
      vi.advanceTimersByTime(1000)
      run("Clear notifications")
      vi.advanceTimersByTime(3000)
      expect(asks()).toEqual([])
    })

    it("keeps the pending finishes of one panel when another clears", () => {
      const { run, asks } = panel("04")
      const other = panel("04")
      run("Fill the notification center")
      other.run("Clear notifications")
      vi.advanceTimersByTime(3000)
      expect(asks()).toHaveLength(12)
    })

    it("has an agent work at a prompt that may hold an unread finish, then leave", () => {
      const { run, worked, actionContext } = panel("04")
      run("Fill the notification center")
      vi.advanceTimersByTime(3000)
      const at = key("02")
      actionContext.dispatch!(backToPrompt(at))
      worked.clear()
      run("Clear notifications")
      vi.advanceTimersByTime(100)
      expect(worked.has(`${at.projectId}/${at.terminalId}`)).toBe(true)
      expect(terminalOf(actionContext.workspace(), at)).toMatchObject({
        state: "idle",
        process: "zsh",
      })
      expect(terminalOf(actionContext.workspace(), at)).not.toHaveProperty("agent")
    })
  })

  context("when new terminals fail", () => {
    it("adds one that fails right after starting", () => {
      const { run, added, terminal } = panel("04")
      run("Quick failure")
      expect(added).toHaveLength(1)
      const slot = terminalSlot(added[0]!.terminalId)
      expect(terminal(slot)?.state).toBe("starting")
      vi.advanceTimersByTime(400)
      expect(terminal(slot)).toMatchObject({
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
