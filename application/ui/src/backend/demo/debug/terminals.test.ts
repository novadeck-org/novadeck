import { isAgentProgram } from "../../../model/process"
import { workspaceFromSeed } from "../../../model/seed"
import { workspaceReducer } from "../../../model/state"
import { terminalEnding } from "../../../model/terminal-ending"
import { terminalPhase } from "../../../model/terminal-ending"
import type { AgentStatus, TerminalMetadata, Workspace } from "../../../model/types"
import { describe, expect, it } from "../../../test"
import type { BackendAction, TerminalKey } from "../../port"
import { demoSeed, demoTerminalId } from "../samples"
import {
  backToPrompt,
  cleanExit,
  exitedWithCode,
  failedToStart,
  killedBy,
  dealKinds,
  noisyAgents,
  othersOf,
  otherTerminals,
  promptTerminals,
  resting,
  runAgent,
  runProgram,
  terminalOf,
  unheardAgent,
  contextOnly,
  withUsage,
} from "./terminals"

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

describe("notification states", () => {
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
