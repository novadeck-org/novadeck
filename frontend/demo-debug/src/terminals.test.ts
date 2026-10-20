import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import { isAgentProgram } from "@novadeck/core/process"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { workspaceReducer } from "@novadeck/core/state"
import { terminalEnding } from "@novadeck/core/terminal-ending"
import { terminalPhase } from "@novadeck/core/terminal-ending"
import type { AgentStatus, TerminalMetadata, Workspace } from "@novadeck/core/types"
import { demoSeed, demoTerminalId } from "@novadeck/demo/samples"
import { terminalOf } from "@novadeck/demo/terminals"

import {
  backToPrompt,
  cleanExit,
  exitedWithCode,
  failedToStart,
  killedBy,
  killedForMemory,
  leadsNext,
  leadsOthers,
  dealKinds,
  noisyAgents,
  othersOf,
  otherTerminals,
  promptTerminals,
  resting,
  runAgent,
  runProgram,
  unheardAgent,
  contextOnly,
  withUsage,
} from "./terminals"
import { describe, expect, it } from "./test"

const initial = workspaceFromSeed(demoSeed(0), { view: "focus", windowedView: "grid", now: 0 })
const project = initial.projects[0]!
const session = project.history[0]!
// A terminal of the first session by its number, as `"04"`.
const key = (slot: string): TerminalKey => ({
  projectId: project.id,
  workspaceSessionId: session.id,
  terminalId: demoTerminalId(
    { projectId: project.id, workspaceSessionId: session.id },
    Number(slot),
  ),
})
const apply = (actions: readonly BackendAction[], from: Workspace = initial): Workspace =>
  actions.reduce(workspaceReducer, from)
const shell = (workspace: Workspace): TerminalMetadata => terminalOf(workspace, key("04"))!
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
const working: AgentStatus = { working: true }
const asking = (kind: "plan" | "question", count: number): AgentStatus => ({
  working: true,
  attention: { kind, count },
})

describe("terminal states", () => {
  it("finds a terminal in the workspace", () => {
    expect(terminalOf(initial, key("04"))?.name).toBe("Checkout review")
    expect(terminalOf(initial, { ...key("01"), terminalId: "nope" })).toBeUndefined()
  })

  it("lists the other live terminals of the session", () => {
    const ended = apply(exitedWithCode(key("02"), 1))
    const ids = othersOf(ended, key("01")).map((terminal) => terminal.id)
    expect(ids).not.toContain(key("01").terminalId)
    expect(ids).not.toContain(key("02").terminalId)
    expect(ids).toContain(key("03").terminalId)
  })

  describe("a shell ending", () => {
    it("closes the tile on a clean exit", () => {
      expect(terminalOf(apply(cleanExit(key("04"))), key("04"))).toBeUndefined()
    })

    it("keeps the terminal with its exit code", () => {
      expect(terminalEnding(shell(apply(exitedWithCode(key("04"), 3))))).toMatchObject({
        status: "Exited",
        reason: "code 3",
      })
    })

    it("says the signal that killed it", () => {
      expect(terminalEnding(shell(apply(killedBy(key("04"), "SIGKILL"))))).toMatchObject({
        status: "Killed",
        reason: "SIGKILL",
      })
    })

    it("says it was killed for memory, where the runner said so", () => {
      expect(terminalEnding(shell(apply(killedForMemory(key("04")))))).toMatchObject({
        status: "Killed",
        reason: "out of memory",
      })
    })

    it("says why it failed to start", () => {
      expect(
        terminalEnding(shell(apply(failedToStart(key("04"), "Folder not found")))),
      ).toMatchObject({ status: "Failed to start", reason: "Folder not found" })
    })

    it("starts a fresh shell after any of them", () => {
      const ended = apply(killedBy(key("04"), "SIGKILL"))
      const fresh = shell(apply(backToPrompt(key("04")), ended))
      expect(fresh).toMatchObject({ state: "idle", process: "zsh" })
      expect(terminalEnding(fresh)).toBeNull()
    })
  })

  it("runs a program in the foreground", () => {
    expect(shell(apply(runProgram(key("04"), "sleep")))).toMatchObject({
      state: "running",
      process: "sleep",
    })
  })

  describe("an agent", () => {
    it("turns a shell into Claude Code", () => {
      const terminal = shell(apply(agentIn(key("04"), shell(initial), working)))
      expect(terminal).toMatchObject({ state: "running", process: "claude", agent: working })
    })

    it("stays the agent that already runs there", () => {
      const codex = apply(runAgent(key("04"), "codex"))
      const next = shell(apply(agentIn(key("04"), shell(codex), asking("plan", 1)), codex))
      expect(next.process).toBe("codex")
      expect(terminalPhase(next)).toBe("attention")
    })

    it("rests after starting", () => {
      const terminal = shell(apply(runAgent(key("04"), "claude")))
      expect(terminal).toMatchObject({ process: "claude", agent: resting })
      expect(terminalPhase(terminal)).toBe("idle")
    })

    it("reports its context and limits", () => {
      const usage = withUsage(1000)
      expect(usage.context).toEqual({ occupied: 84_000, capacity: 200_000 })
      expect(usage.limits.every((limit) => limit.resetsAt! > 1000)).toBe(true)
    })

    it("reports its tokens alone where its harness gives no size", () => {
      expect(contextOnly).toMatchObject({ context: { capacity: null }, limits: [] })
    })

    it("is unheard when it runs without reporting", () => {
      expect(terminalPhase(shell(apply(unheardAgent(key("04"), "claude"))))).toBe("unheard")
    })
  })
})

describe("waiting agents' states", () => {
  it("lists the live terminals but the viewed one, project by project in turn", () => {
    const keys = otherTerminals(initial, key("04"))
    expect(keys).not.toContainEqual(key("04"))
    expect(keys[0]!.projectId).toBe(initial.projects[0]!.id)
    expect(keys[1]!.projectId).toBe(initial.projects[1]!.id)
    const ended = apply(exitedWithCode(key("02"), 1))
    expect(otherTerminals(ended, key("04"))).not.toContainEqual(key("02"))
  })

  it("deals the kinds in turn", () => {
    expect(dealKinds(7)).toEqual([
      "question",
      "permission",
      "plan",
      "failed",
      "done",
      "question",
      "permission",
    ])
  })

  it("finds the agents that work, ask or finished", () => {
    const asked = apply(agentIn(key("02"), undefined, asking("plan", 1)))
    expect(noisyAgents(asked)).toContainEqual(key("02"))
    const finished = apply(
      agentIn(key("03"), undefined, { working: false, lastTurn: { outcome: "failed", at: 1 } }),
      asked,
    )
    expect(noisyAgents(finished)).toEqual(expect.arrayContaining([key("02"), key("03")]))
    const rested = apply(agentIn(key("02"), undefined, resting), finished)
    expect(noisyAgents(rested)).not.toContainEqual(key("02"))
    // Work left running behind a turn, or by subagents, is as much to rest.
    const background = apply(
      agentIn(key("02"), undefined, { working: false, background: { agents: 0, tasks: 1 } }),
    )
    expect(noisyAgents(background)).toContainEqual(key("02"))
    const subagents = apply(
      agentIn(key("02"), undefined, { working: false, subagents: [{ id: "s", type: null }] }),
    )
    expect(noisyAgents(subagents)).toContainEqual(key("02"))
  })

  it("finds the terminals back at their prompt, however they got there", () => {
    expect(promptTerminals(initial)).not.toContainEqual(key("04"))
    const prompt = apply(backToPrompt(key("04")))
    expect(promptTerminals(prompt)).toContainEqual(key("04"))
    const running = apply(runProgram(key("04"), "sleep"), prompt)
    expect(promptTerminals(running)).not.toContainEqual(key("04"))
    const ended = apply(exitedWithCode(key("04"), 1), prompt)
    expect(promptTerminals(ended)).not.toContainEqual(key("04"))
  })
})

// The workspace with one terminal's handle taken away.
const withoutHandle = (workspace: Workspace, id: string): Workspace => ({
  ...workspace,
  projects: workspace.projects.map((each) => ({
    ...each,
    history: each.history.map((entry) => ({
      ...entry,
      state: {
        ...entry.state,
        roster: {
          ...entry.state.roster,
          terminals: entry.state.roster.terminals.map(({ handle, ...rest }) =>
            rest.id === id ? rest : { ...rest, ...(handle ? { handle } : {}) },
          ),
        },
      },
    })),
  })),
})

describe("leading the others", () => {
  it("makes every other live terminal of the session name the selected one as its lead", () => {
    const lead = terminalOf(initial, key("01"))!
    const led = leadsOthers(initial, key("01")).reduce(workspaceReducer, initial)
    const others = othersOf(initial, key("01"))
    expect(others.length).toBeGreaterThan(0)
    for (const other of others)
      expect(terminalOf(led, { ...key("01"), terminalId: other.id })?.ledBy).toBe(lead.handle)
  })

  it("does nothing for a terminal without a handle to lead by", () => {
    const nameless = withoutHandle(initial, key("01").terminalId)
    expect(leadsOthers(nameless, key("01"))).toEqual([])
  })
})

describe("leading the next terminal", () => {
  it("makes the next live terminal after the selected one name it as its lead", () => {
    const lead = terminalOf(initial, key("01"))!
    const led = leadsNext(initial, key("01")).reduce(workspaceReducer, initial)
    expect(terminalOf(led, key("02"))?.ledBy).toBe(lead.handle)
    expect(terminalOf(led, key("03"))?.ledBy).toBe(terminalOf(initial, key("03"))?.ledBy)
  })

  it("passes over a terminal that has ended", () => {
    const ended = apply(exitedWithCode(key("02"), 1), initial)
    const led = leadsNext(ended, key("01")).reduce(workspaceReducer, ended)
    expect(terminalOf(led, key("03"))?.ledBy).toBe(terminalOf(initial, key("01"))!.handle)
  })

  it("does nothing for the last terminal", () => {
    const last = othersOf(initial, key("01")).at(-1)!
    expect(last.handle).toBeDefined()
    expect(leadsNext(initial, { ...key("01"), terminalId: last.id })).toEqual([])
  })

  it("does nothing for a terminal without a handle to lead by", () => {
    expect(leadsNext(withoutHandle(initial, key("01").terminalId), key("01"))).toEqual([])
  })
})
