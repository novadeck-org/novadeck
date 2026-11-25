import type { AgentName } from "@novadeck/protocol"
import type { ApartProcess } from "@novadeck/terminal/pty"

import { harnesses } from "../harnesses/registry.js"
import type { Record } from "./record.js"

// How long a closed terminal's agent and what it started, and on Windows all its programs, have
// to end by themselves, in milliseconds: on Windows, within the five seconds its CTRL_CLOSE_EVENT gives
// them, saving what they were writing. What is left then is ended. Shorter as the runner shuts
// down, which the app gives five seconds in all (apps/desktop/src/main/runner.ts): long enough
// for Claude Code to end a tool that ignores it, which takes it 1.7 s, and for agents to save,
// which takes under 0.9 s on Linux and macOS (#721).
export const treeGraceMs = 3_000
export const shutdownTreeGraceMs = 2_000

// How long ending terminals' trees may take in all as the runner shuts down, in
// milliseconds: every relay run, taskkill and grace then takes its time from this, within
// the five seconds the app gives the runner, with room for a shell's exit (its own 1 s wait)
// and for closing the rest of the runner after. On Linux and macOS an agent's processes take
// their share of it too: the 2 s grace, a listing, half a second for SIGTERM and a listing,
// about 2.6 s, and 3.15 s at most, if both listings past the bound take their whole limit.
export const shutdownTreesMs = 3_000

/**
 * The pid of the agent bound to this terminal, as its hooks told it, for a close or a quit
 * to follow what it started; the pty goes by it only if it still holds the foreground.
 * Undefined with none yet: Codex and Antigravity bind at their first turn, before which they
 * have started no tool to leave behind.
 */
export const agentProcess = (record: Pick<Record, "bound"> | undefined): number | undefined => {
  const pid = Number(record?.bound?.binding.instance ?? Number.NaN)
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined
}

/**
 * How long, in milliseconds, the agent bound to this terminal is left running before its end:
 * what its harness says it needs after a turn's end (`Harness.saveMs`) less what has passed,
 * none once it has had it, or while it works, as a turn's end is what starts the wait.
 */
export const savingMs = (
  record: Pick<Record, "bound"> | undefined,
  now: number = Date.now(),
): number => {
  const bound = record?.bound
  if (!bound || bound.activity.state !== "idle") return 0
  const save = harnesses[bound.binding.agent].saveMs
  return save === undefined ? 0 : Math.max(0, bound.activity.turnAt + save - now)
}

/**
 * What the harnesses of a terminal's agents run apart from it (`Harness.apart`), found by
 * each session's own transcript: the bound session's, and with none bound, each harness's
 * latest session there. A harness's service started from this terminal sits in its scope,
 * though its agent has ended, and the person's other sessions still use it, so what an agent
 * left there is ended around it (see the pty's `endLeft`).
 */
export const apartOf = async (
  record: Pick<Record, "bound" | "agents"> | undefined,
): Promise<readonly ApartProcess[]> => {
  if (!record) return []
  const binding = record.bound?.binding
  const sessions = binding
    ? [{ agent: binding.agent, sessionId: binding.sessionId }]
    : Object.entries(record.agents).flatMap(([agent, report]) =>
        report ? [{ agent: agent as AgentName, sessionId: report.sessionId }] : [],
      )
  const found = await Promise.all(
    sessions.map(async ({ agent, sessionId }) => {
      const apart = harnesses[agent].apart
      const report = record.agents[agent]
      if (!apart) return []
      const transcript = report?.sessionId === sessionId ? report.transcript : undefined
      return apart({ transcript }).catch(() => [])
    }),
  )
  return found.flat()
}

/**
 * What the terminal host follows as terminal `id` closes, by its record in `records`: its
 * agent (`agentProcess`), and what its agents' harnesses run apart from the terminal, which
 * the close leaves (`apartOf`). Taken as the close begins, so the binding it goes by is the one
 * the closed terminal had.
 */
export const closing = (records: {
  get(id: string): Pick<Record, "bound" | "agents"> | undefined
}) => ({
  follows: (id: string) => agentProcess(records.get(id)),
  apart: (id: string) => apartOf(records.get(id)),
  settle: (id: string) => savingMs(records.get(id)),
})
