import { subagentsBadge } from "../../../model/agent-subagents"
import { workspaceFromSeed } from "../../../model/seed"
import { workspaceReducer } from "../../../model/state"
import { terminalEnding } from "../../../model/terminal-ending"
import { terminalPhase } from "../../../model/terminal-ending"
import type { TerminalMetadata, Workspace } from "../../../model/types"
import { describe, expect, it } from "../../../test"
import type { BackendAction, TerminalKey } from "../../port"
import { demoSeed, demoTerminalId } from "../samples"
import {
  agentIn,
  asking,
  backToPrompt,
  cleanExit,
  exitedWithCode,
  failedToStart,
  killedBy,
  dealKinds,
  noisyTerminals,
  othersOf,
  otherTerminals,
  resting,
  runAgent,
  runProgram,
  terminalOf,
  turnEnded,
  unheardAgent,
  backgroundWork,
  withSubagents,
  withUsage,
  working,
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

    it("counts what waits on the person", () => {
      const terminal = shell(apply(agentIn(key("04"), undefined, asking("permission", 3))))
      expect(terminal).toMatchObject({ agent: { attention: { kind: "permission", count: 3 } } })
    })

    it("reports the subagents it runs", () => {
      const terminal = shell(apply(agentIn(key("04"), undefined, withSubagents)))
      expect(subagentsBadge(terminal)).toBe("3 subagents")
    })

    it("reports what its turn left running in the background", () => {
      const terminal = shell(apply(agentIn(key("04"), undefined, backgroundWork)))
      expect(subagentsBadge(terminal)).toBe("1 agent · 2 tasks")
    })

    it("reports its context and limits", () => {
      const { usage } = withUsage(1000)
      expect(usage?.context).toEqual({ occupied: 84_000, capacity: 200_000 })
      expect(usage?.limits.every((limit) => limit.resetsAt! > 1000)).toBe(true)
    })

    it("ends a turn with a reply, except where its harness gives none", () => {
      expect(turnEnded("completed", 5).lastTurn).toMatchObject({ outcome: "completed", at: 5 })
      expect(turnEnded("completed", 5).lastTurn?.reply).toBeTruthy()
      expect(turnEnded("unknown", 5).lastTurn).toEqual({ outcome: "unknown", at: 5 })
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

  it("finds the terminals that ask or finished", () => {
    expect(noisyTerminals(initial)).toEqual([])
    const asked = apply(agentIn(key("02"), undefined, asking("plan", 1)))
    expect(noisyTerminals(asked)).toEqual([key("02")])
    const ended = apply(agentIn(key("03"), undefined, turnEnded("failed", 1)), asked)
    expect(noisyTerminals(ended)).toEqual([key("02"), key("03")])
  })
})
