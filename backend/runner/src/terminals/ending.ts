import type { Record } from "./record.js"

// How long a closed terminal's agent, and on Windows all its programs, have to end by
// themselves, in milliseconds: on Windows, within the five seconds its CTRL_CLOSE_EVENT gives
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
// about 2.6 s, and 3.15 s if both listings take their whole limit.
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
