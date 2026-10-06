import type { TerminalMetadata } from "../model/types"

// The agent CLIs Novadeck runs, by `programName`: Claude Code, Codex and Antigravity.
const agentPrograms = new Set(["claude", "codex", "agy"])

// Whether a terminal is running a coding agent, which is where a mic button earns its
// place: a prompt there is prose, spoken more easily than typed. A running agent that
// reports through its hooks has said so itself; the others are known by name, before
// their first report. A shell prompt is commands, which the shortcut still serves.
export const isAgentTerminal = (terminal: TerminalMetadata): boolean =>
  terminal.state === "running" &&
  (terminal.agent !== undefined || agentPrograms.has(terminal.process))
