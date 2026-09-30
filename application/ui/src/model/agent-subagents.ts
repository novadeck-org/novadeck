import type { TerminalMetadata } from "./types"

const subagentsOf = (terminal: TerminalMetadata) =>
  terminal.state === "running" ? (terminal.agent?.subagents ?? []) : []

// How many subagents the agent runs, for its window's header: "2 subagents". Undefined
// without any.
export const subagentsBadge = (terminal: TerminalMetadata): string | undefined => {
  const { length } = subagentsOf(terminal)
  if (length === 0) return undefined
  return length === 1 ? "1 subagent" : `${length} subagents`
}

// Which kinds they are, in the harness's own words, counted: "2 explorer, 1 worker".
export const subagentsDetail = (terminal: TerminalMetadata): string | undefined => {
  const counts = new Map<string, number>()
  for (const { type } of subagentsOf(terminal)) {
    const kind = type || "subagent"
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  if (counts.size === 0) return undefined
  return [...counts].map(([kind, count]) => `${count} ${kind}`).join(", ")
}
