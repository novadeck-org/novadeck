import type { Inbox } from "@novadeck/core/inbox"
import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { terminalPhase } from "@novadeck/core/terminals/ending"
import { isAgentProgram } from "@novadeck/core/terminals/process"
import type { AgentStatus, AgentUsage, TerminalMetadata, Workspace } from "@novadeck/core/types"
import type { DemoAgentVerbs } from "@novadeck/demo/agent-link"
import { createMockTerminal, demoSeed, demoTerminalId, terminalSlot } from "@novadeck/demo/samples"
import { terminalOf } from "@novadeck/demo/terminals"
import { demoTurns } from "@novadeck/demo/turns"
import { createDemo } from "@novadeck/demo/variants"
import { afterEach, beforeEach, vi } from "vitest"

import { createDemoStates } from "./states"
import { backToPrompt, runProgram } from "./terminals"
import { context, describe, expect, it } from "./test"
import { demoSections, type DemoActionContext, type DemoTarget } from "./types"

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

// An agent in the terminal with this status; a terminal not running one becomes Claude Code.
const agentIn = (
  at: TerminalKey,
  terminal: TerminalMetadata | undefined,
  agent: AgentStatus,
): BackendAction[] => [
  ...(terminal && isAgentProgram(terminal.process) ? [] : runProgram(at, "claude").slice(0, 1)),
  {
    type: "terminal/status",
    target: { projectId: at.projectId, workspaceSessionId: at.workspaceSessionId },
    terminalId: at.terminalId,
    status: { state: "running", agent },
  },
]

// A verb the panel called, on which terminal, and whether the workspace held it.
type VerbCall = {
  readonly verb: keyof DemoAgentVerbs
  readonly key: TerminalKey
  readonly known: boolean
  readonly args: readonly unknown[]
}

// Verbs that record their calls and show them in the workspace as plainly as the agents'
// owner would: working, waiting on requests, a finished turn, resting. Its own tests cover
// the rest.
const verbs = (
  calls: VerbCall[],
  released: TerminalKey[],
  workspace: { transact: (actions: readonly BackendAction[]) => unknown },
): DemoAgentVerbs => {
  const say = (at: TerminalKey, terminal: TerminalMetadata | undefined, agent: AgentStatus) =>
    void workspace.transact(agentIn(at, terminal, agent))
  const record = (
    verb: keyof DemoAgentVerbs,
    at: TerminalKey,
    terminal: TerminalMetadata | undefined,
    args: readonly unknown[],
  ): void => void calls.push({ verb, key: at, known: terminal !== undefined, args })
  return {
    work: (at, terminal, ...args) => {
      record("work", at, terminal, args)
      say(at, terminal, { working: true })
    },
    ask: (at, terminal, ...args) => {
      record("ask", at, terminal, args)
      say(at, terminal, {
        working: true,
        attention: { kind: args[0] as "plan", count: args[1] as number },
      })
    },
    finish: (at, terminal, ...args) => {
      record("finish", at, terminal, args)
      say(at, terminal, { working: true })
      const {
        after = 0,
        waiting,
        error,
        limit,
      } = (args[1] ?? {}) as {
        after?: number
        waiting?: unknown
        error?: string
        limit?: { minutes: number; resetsAt: number }
      }
      setTimeout(
        () =>
          say(at, terminal, {
            working: false,
            // Whatever it waits on, as a job that began now.
            ...(waiting
              ? {
                  waiting: {
                    jobs: [
                      {
                        id: "job",
                        description: "Watch CI checks",
                        command: "gh pr checks --watch",
                        since: Date.now(),
                        until: null,
                      },
                    ],
                    wake: null,
                  },
                }
              : {}),
            lastTurn: {
              outcome: args[0] as "completed",
              ...(error ? { error } : {}),
              ...(limit ? { limit } : {}),
              at: Date.now(),
            },
          }),
        after,
      )
    },
    rest: (at, terminal) => {
      record("rest", at, terminal, [])
      say(at, terminal, { working: false })
    },
    usage: (at, terminal, usage) => {
      record("usage", at, terminal, [usage])
      say(at, terminal, { working: false })
    },
    release: (at) => void released.push(at),
  }
}

// A panel over a real workspace, with the terminal on screen as given. It records what the
// panel does that the app would take for a person's move: adding a terminal the way "+"
// does (which selects it and shows the Terminals panel), and the verbs it calls on the agents.
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
  const calls: VerbCall[] = []
  const released: TerminalKey[] = []
  let aimed: DemoTarget = "selected"
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
    get target() {
      return aimed
    },
    selected: () => (selected && onScreen() ? inSession(onScreen()!) : undefined),
    select: () => {},
    addTerminal: () => {
      const created = create(true)
      plus.push(created)
      return created
    },
    addInBackground: () => create(false),
    startFresh: () => {},
    dispatch: (actions: readonly BackendAction[]) => void workspace.transact(actions),
    workspace: () => workspace.getSnapshot(),
    note: (text) => void notes.push(text),
  }
  const read = vi.fn<NonNullable<Inbox["readFinishes"]>>()
  const states = createDemoStates(
    verbs(calls, released, workspace),
    () => ({ readFinishes: read }) as unknown as Inbox,
  )
  const find = (label: string) =>
    states.groups.flatMap((group) => group.actions).find((action) => action.label === label)!
  const terminal = (slot: string) =>
    workspace
      .getSnapshot()
      .projects[0]!.history[0]!.state.roster.terminals.find((each) => each.id === id(slot))
  return {
    states,
    read,
    actionContext,
    notes,
    added,
    plus,
    calls,
    released,
    aim: (next: DemoTarget) => void (aimed = next),
    find,
    terminal,
    onScreen,
    run: (label: string) => find(label).run(actionContext),
  }
}

// What each terminal other than the one on screen asks of the person: its request, or an
// agent that finished (which the app marks unread, as the person looks elsewhere).
const asksOf = (workspace: Workspace, viewed: TerminalKey) =>
  workspace.projects.flatMap((each) =>
    each.history.flatMap((owner) =>
      owner.state.roster.terminals.flatMap((entry) => {
        const agent = entry.state === "running" ? entry.agent : undefined
        const kind = agent?.attention?.kind ?? agent?.lastTurn?.outcome
        const looked =
          each.id === viewed.projectId &&
          owner.id === viewed.workspaceSessionId &&
          entry.id === viewed.terminalId
        return kind && !looked
          ? [
              {
                projectId: each.id,
                sessionId: owner.id,
                terminalId: entry.id,
                kind,
              },
            ]
          : []
      }),
    ),
  )

describe("demo states", () => {
  it("puts each of its new terminals in its own state, the finished ones first", async () => {
    const { run, added, terminal } = panel("04")
    await run("Every state at once")
    vi.advanceTimersByTime(3000)
    const shown = added.map((each) => terminal(terminalSlot(each.terminalId))!)
    expect(shown.map((each) => each.name)).toContain("Needs permission")
    expect(shown.at(-1)).toMatchObject({
      name: "Needs permission",
      agent: { attention: { kind: "permission", count: 1 } },
    })
    expect(shown[0]).toMatchObject({
      name: "Done",
      agent: { lastTurn: { outcome: "completed" } },
    })
    expect(shown[1]).toMatchObject({
      name: "Replied, unread",
      agent: { lastTurn: { outcome: "completed" } },
    })
    expect(shown[2]).toMatchObject({ agent: { lastTurn: { outcome: "failed" } } })
    expect(shown.find((each) => each.name === "Paused at its limit")).toMatchObject({
      agent: { working: false, lastTurn: { limit: { minutes: 300 } } },
    })
    // A dialog is no phase: the need mark shows it, the glyph that the agent rests.
    expect(new Set(shown.map((each) => terminalPhase(each)))).toEqual(
      new Set(["idle", "running", "waiting", "paused", "unheard", "starting", "ended"]),
    )
  })

  it("gives the agent tiles their states through the verbs, not the terminal's metadata", async () => {
    const { run, calls } = panel("04")
    await run("Every state at once")
    expect(calls.map((call) => call.verb).toSorted()).toEqual(
      [
        ...Array<string>(3).fill("ask"),
        ...Array<string>(1).fill("ask"),
        ...Array<string>(6).fill("finish"),
        ...Array<string>(4).fill("work"),
      ].toSorted(),
    )
    expect(calls.every((call) => !call.known)).toBe(true)
  })

  it("groups its actions under the panel's sections, each with a hint and a label of its own", () => {
    const { states } = panel("04")
    for (const group of states.groups) {
      expect(demoSections).toContain(group.section)
      const labels = group.actions.map((action) => action.label)
      // The panel keys an action by its label within its group.
      expect(new Set(labels).size).toBe(labels.length)
      for (const action of group.actions) expect(action.hint).not.toBe("")
    }
  })

  it("lets only the agent group choose a target", () => {
    const { states } = panel("04")
    expect(states.groups.filter((group) => group.targets).map((group) => group.title)).toEqual([
      "Agent",
    ])
  })

  context("with no terminal selected", () => {
    it("asks for one instead of acting", () => {
      const { run, notes, terminal, calls } = panel(undefined)
      run("Exit code 3")
      run("Work")
      expect(notes).toEqual(["Select a terminal first.", "Select a terminal first."])
      expect(calls).toEqual([])
      expect(terminal("04")).toMatchObject({ state: "running", process: "zsh" })
    })
  })

  context("with a terminal selected", () => {
    it("ends its shell as the action says", () => {
      const { run, terminal } = panel("04")
      run("Killed (SIGKILL)")
      expect(terminal("04")).toMatchObject({ state: "exited", signal: "SIGKILL" })
    })

    it("lets an unheard agent say nothing", () => {
      const { run, terminal, calls } = panel("04")
      run("Unheard agent")
      expect(terminalPhase(terminal("04")!)).toBe("unheard")
      expect(calls).toEqual([])
    })

    it("notes that an unheard agent has no usage, and sets nothing", () => {
      const { run, notes, calls } = panel("04")
      run("Unheard agent")
      calls.length = 0
      run("Context and limits")
      expect(notes.at(-1)).toContain("hears nothing")
      expect(calls).toEqual([])
    })

    it("sets usage and tokens through the usage verb, on the selected terminal", () => {
      const { run, terminal, calls, released } = panel("04")
      run("Context and limits")
      expect(terminal("04")).toMatchObject({ process: "claude" })
      run("Context, no size")
      expect(calls.map((call) => [call.verb, call.key])).toEqual([
        ["usage", key("04")],
        ["usage", key("04")],
      ])
      expect(calls.map((call) => (call.args[0] as AgentUsage).context)).toEqual([
        { occupied: 84_000, capacity: 200_000 },
        { occupied: 84_000, capacity: null },
      ])
      // It sets nothing but usage, so what the agent had pending stays.
      expect(released).toEqual([])
    })
  })

  context("when the panel sets a terminal's state without a verb", () => {
    it.each([
      "Starting shell",
      "At the prompt",
      "Long program",
      "Claude Code",
      "Codex",
      "Clean exit",
      "Exit code 3",
      "Exit, no code",
      "Killed (SIGKILL)",
      "Failed to start",
      "Unheard agent",
    ])("lets the selected terminal's agent go first on %s", (label) => {
      const { run, released } = panel("04")
      run(label)
      expect(released).toEqual([key("04")])
    })

    it("leaves its agent be where only the screen changes", () => {
      const { run, released } = panel("04")
      run("Loading output")
      run("Paste fails")
      expect(released).toEqual([])
    })

    it("lets the agent go of a terminal it restarts", () => {
      const { states, released, actionContext } = panel("04")
      states.restart(key("04"), actionContext.dispatch!)
      expect(released).toEqual([key("04")])
    })

    it("lets go of the terminals of the gallery's metadata tiles, not its agents'", async () => {
      const { run, released, added } = panel("04")
      await run("Every state at once")
      // The ten that set no agent verb: two that ask through MCP (their Inbox items are the
      // demo's own), unheard, program, a shell an agent opened, one an
      // agent exited from, starting, and the three ways to end.
      expect(released).toHaveLength(10)
      for (const each of released) expect(added).toContainEqual(each)
      expect(new Set(released.map((each) => each.terminalId)).size).toBe(10)
    })

    it("calls its verbs without letting go", () => {
      const { run, released } = panel("04")
      run("Completes")
      run("Rest")
      expect(released).toEqual([])
    })
  })

  context("with the agent verbs", () => {
    const verbOf = (label: string) => {
      const { run, calls, aim } = panel("04")
      run(label)
      return { calls, aim, run }
    }

    it("calls one verb on the selected terminal, with what it was", () => {
      const { calls } = verbOf("Needs permission")
      expect(calls).toEqual([{ verb: "ask", key: key("04"), known: true, args: ["permission", 1] }])
    })

    it.each([
      ["Work", "work", []],
      ["Plan mode", "work", [{ planning: true }]],
      ["Subagents", "work", [{ subagents: true }]],
      ["Asks a question", "ask", ["question", 1]],
      ["Plan ready", "ask", ["plan", 1]],
      ["3 permissions", "ask", ["permission", 3]],
      [
        "Completes",
        "finish",
        [
          "completed",
          { after: 3000, done: { subject: expect.any(String), body: expect.any(String) } },
        ],
      ],
      ["Replies, no done call", "finish", ["completed", { after: 3000 }]],
      ["Fails", "finish", ["failed", { after: 3000 }]],
      ["Interrupted", "finish", ["interrupted", { after: 3000 }]],
      ["Ends without reply", "finish", ["unknown", { after: 3000 }]],
      [
        "Background work",
        "finish",
        ["completed", { after: 3000, background: { agents: 0, tasks: 2 } }],
      ],
      [
        "Background, uncounted",
        "finish",
        ["completed", { after: 3000, background: { agents: 0, tasks: 0 } }],
      ],
      [
        "Finishing subagents",
        "finish",
        ["completed", { after: 3000, background: { agents: 2, tasks: 0 } }],
      ],
      ["Rest", "rest", []],
    ])("%s calls %s", (label, verb, args) => {
      const { calls } = verbOf(label)
      expect(calls).toEqual([{ verb, key: key("04"), known: true, args }])
    })

    it("makes the selected shell an agent, working", () => {
      const { run, terminal } = panel("04")
      run("Work")
      expect(terminal("04")).toMatchObject({ process: "claude", agent: { working: true } })
    })

    it("acts on another terminal of the session, not the one on screen", () => {
      const { run, calls, aim } = panel("04")
      aim("terminal")
      run("Completes")
      expect(calls).toHaveLength(1)
      expect(calls[0]!.key.terminalId).not.toBe(id("04"))
      expect(calls[0]!.key).toMatchObject({ projectId: project.id, workspaceSessionId: session.id })
      expect(calls[0]!.known).toBe(true)
    })

    it("adds a terminal in the background when the session has no other", () => {
      const { run, calls, aim, added, plus, onScreen } = panel("04", { keeping: 0 })
      aim("terminal")
      run("Completes")
      expect(added).toHaveLength(1)
      expect(plus).toEqual([])
      expect(onScreen()).toBe(id("04"))
      expect(calls).toMatchObject([{ verb: "finish", key: added[0] }])
    })

    it("acts on the first terminal of another project, not the one on screen", () => {
      const { run, calls, aim, terminal } = panel("04")
      aim("project")
      run("Needs permission")
      const other = initial.projects[1]!
      expect(other.id).not.toBe(project.id)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.key.projectId).toBe(other.id)
      expect(terminal("04")).not.toHaveProperty("agent")
    })

    it("asks for another project when there is none", () => {
      const { run, notes, calls, aim } = panel("04")
      aim("project")
      const only = { ...initial, projects: [initial.projects[0]!] }
      const lone = createDemoStates(verbs([], [], { transact: () => undefined }))
      const action = lone.groups
        .flatMap((group) => group.actions)
        .find((each) => each.label === "Work")!
      void run
      action.run({
        selected: () => key("04"),
        select: () => {},
        addTerminal: () => key("04"),
        addInBackground: () => key("04"),
        startFresh: () => {},
        dispatch: () => {},
        workspace: () => only,
        note: (text) => void notes.push(text),
        target: "project",
      })
      expect(notes).toEqual(["Add another project with a terminal first."])
      expect(calls).toEqual([])
    })
  })

  context("with the Inbox filled from waiting agents", () => {
    it("asks for the terminal on screen first", () => {
      const { run, notes } = panel(undefined)
      run("Fill the Inbox")
      expect(notes).toEqual(["Select a terminal first."])
    })

    it("fills it with every kind, across projects, past the badge's cap", () => {
      const { run, actionContext } = panel("04")
      run("Fill the Inbox")
      vi.advanceTimersByTime(3000)
      const all = asksOf(actionContext.workspace()!, key("04"))
      expect(all).toHaveLength(12)
      expect(new Set(all.map((each) => each.kind))).toEqual(
        new Set(["question", "permission", "plan", "failed", "completed"]),
      )
      expect(new Set(all.map((each) => each.projectId)).size).toBeGreaterThan(1)
      expect(
        all.some((each) => each.projectId === project.id && each.terminalId === id("04")),
      ).toBe(false)
    })

    it("asks with the verbs, and finishes after the usual turn", () => {
      const { run, calls } = panel("04")
      run("Fill the Inbox")
      expect(calls).toHaveLength(12)
      for (const call of calls) {
        if (call.verb === "ask") expect(call.args[1]).toBe(1)
        else expect(call.args[1]).toMatchObject({ after: 3000 })
      }
      expect(new Set(calls.map((call) => call.verb))).toEqual(new Set(["ask", "finish"]))
    })

    it("adds what it needs without selecting it, so every finish lands elsewhere", () => {
      const { run, onScreen, plus, added, actionContext } = panel("04", { keeping: 3 })
      run("Fill the Inbox")
      vi.advanceTimersByTime(3000)
      expect(added.length).toBeGreaterThan(0)
      // Not through the app's "+", which selects the terminal and shows the Terminals panel.
      expect(plus).toEqual([])
      expect(onScreen()).toBe(id("04"))
      const asks = asksOf(actionContext.workspace()!, key("04"))
      expect(asks).toHaveLength(12)
      for (const each of added)
        expect(asks.some((entry) => entry.terminalId === each.terminalId)).toBe(true)
    })

    it("empties it again, resting every agent that works, asks or finished", () => {
      const { run, calls, actionContext } = panel("04")
      run("Fill the Inbox")
      vi.advanceTimersByTime(3000)
      calls.length = 0
      run("Clear waiting agents")
      vi.advanceTimersByTime(100)
      expect(asksOf(actionContext.workspace()!, key("04"))).toEqual([])
      expect(calls.filter((call) => call.verb === "rest").length).toBeGreaterThanOrEqual(12)
    })

    it("calls off the finishes still pending by working, then resting their agents", () => {
      const { run, calls } = panel("04")
      run("Fill the Inbox")
      vi.advanceTimersByTime(1000)
      calls.length = 0
      run("Clear waiting agents")
      expect(calls.filter((call) => call.verb === "work").length).toBeGreaterThanOrEqual(12)
      vi.advanceTimersByTime(100)
      expect(calls.filter((call) => call.verb === "rest").length).toBeGreaterThanOrEqual(12)
    })

    it("reads the finishes the Inbox stored, of every terminal", () => {
      const { run, read, actionContext } = panel("04")
      run("Clear waiting agents")
      const finishes = actionContext.workspace()!.projects.flatMap((each) =>
        each.history.flatMap((owner) =>
          owner.state.roster.terminals.map((entry) => ({
            context: `${each.id}/${owner.id}`,
            terminalId: entry.id,
          })),
        ),
      )
      expect(read).toHaveBeenCalledExactlyOnceWith(finishes)
    })

    it("has an agent work at a prompt that may hold an unread finish, then leave", () => {
      const { run, calls, actionContext } = panel("04")
      const at = key("02")
      actionContext.dispatch!(backToPrompt(at))
      run("Clear waiting agents")
      expect(calls).toContainEqual(expect.objectContaining({ verb: "work", key: at }))
      vi.advanceTimersByTime(100)
      expect(calls).toContainEqual(expect.objectContaining({ verb: "rest", key: at }))
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
    run("Exit code 3")
    states.restart(key("04"), actionContext.dispatch!)
    expect(terminal("04")).toMatchObject({ state: "idle", process: "zsh" })
  })
})

// The panel over the demo's real agents: `demoTurns` and the backend it owns the agents of.
const openOver = (variant: "plain" | "agents") => {
  const turns = demoTurns()
  const backend = createDemo(variant, undefined, turns)
  const workspace = createWorkspaceStore(
    workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 0 }),
    backend.commit,
  )
  backend.commit(workspace.getSnapshot(), [])
  backend.start!({
    dispatch: (actions) => workspace.transact(actions as never),
    open: () => {},
  })
  const first = workspace.getSnapshot().projects[0]!
  const owner = first.history.find((each) => each.id === first.activeSessionId)!
  const viewed: TerminalKey = {
    projectId: first.id,
    workspaceSessionId: owner.id,
    terminalId: owner.state.roster.terminals[0]!.id,
  }
  const surface: DemoActionContext = {
    target: "selected",
    selected: () => viewed,
    select: () => {},
    addTerminal: () => viewed,
    addInBackground: (to) => {
      const target = { projectId: to.projectId, workspaceSessionId: to.workspaceSessionId }
      const terminal = backend.newTerminal({ target, directory: "~" })
      workspace.transact([{ type: "terminal/add", target, terminal, select: false }])
      return { ...target, terminalId: terminal.id }
    },
    startFresh: () => {},
    dispatch: (batch) => void workspace.transact(batch as never),
    workspace: () => workspace.getSnapshot(),
    note: () => {},
  }
  const states = createDemoStates(turns)
  const run = (label: string): void =>
    void states.groups
      .flatMap((group) => group.actions)
      .find((action) => action.label === label)!
      .run(surface)
  return { backend, workspace, viewed, run }
}

describe("demo states over the real agents", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  for (const variant of ["plain", "agents"] as const) {
    it(`keeps a finish due later from undoing an exit (${variant})`, () => {
      const { run, workspace, viewed } = openOver(variant)
      run("Completes")
      run("Exit code 3")
      vi.advanceTimersByTime(10_000)
      const terminal = terminalOf(workspace.getSnapshot(), viewed)
      expect(terminal).toMatchObject({ state: "exited", exitCode: 3 })
      expect(terminal).not.toHaveProperty("agent")
    })

    it(`leaves nothing to read, ask or work after Fill then Clear (${variant})`, () => {
      const { run, workspace, backend } = openOver(variant)
      run("Fill the Inbox")
      vi.advanceTimersByTime(3_500)
      run("Clear waiting agents")
      vi.advanceTimersByTime(10_000)
      for (const each of workspace.getSnapshot().projects)
        for (const owner of each.history)
          for (const terminal of owner.state.roster.terminals) {
            const agent = terminal.state === "running" ? terminal.agent : undefined
            const at = {
              projectId: each.id,
              workspaceSessionId: owner.id,
              terminalId: terminal.id,
            }
            const where = `${each.id}/${terminal.name}`
            expect(agent?.attention, where).toBeUndefined()
            expect(agent?.lastTurn, where).toBeUndefined()
            expect(agent?.working ?? false, where).toBe(false)
            if (agent)
              expect(backend.conversations!.conversation(at).getSnapshot().requests, where).toEqual(
                [],
              )
          }
    })
  }
})
