import type { TerminalMetadata } from "./types"

const agentOf = (terminal: TerminalMetadata) =>
  terminal.state === "running" ? terminal.agent : undefined

const subagentsOf = (terminal: TerminalMetadata) => agentOf(terminal)?.subagents ?? []

const counted = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`

// What the agent's ended turn left running, for its window's header: "3 agents · 1 task",
// or "background work" where its harness doesn't count it. Else how many subagents it
// runs: "2 subagents". Undefined without either.
export const subagentsBadge = (terminal: TerminalMetadata): string | undefined => {
  const background = agentOf(terminal)?.background
  if (background) {
    const parts = [
      ...(background.agents > 0 ? [counted(background.agents, "agent")] : []),
      ...(background.tasks > 0 ? [counted(background.tasks, "task")] : []),
    ]
    return parts.length > 0 ? parts.join(" · ") : "background work"
  }
  const { length } = subagentsOf(terminal)
  if (length === 0) return undefined
  return counted(length, "subagent")
}

// Which kinds they are, in the harness's own words, counted: "2 explorer, 1 worker". For
// what its ended turn left running, whether the agent works on until that finishes, as
// it does for subagents, which wake it, or not, as for a command, which may run for ever.
export const subagentsDetail = (terminal: TerminalMetadata): string | undefined => {
  const agent = agentOf(terminal)
  if (agent?.background)
    return agent.working
      ? "Its turn is over, but subagents it started still run: it works on until they finish"
      : "Its turn is over; work it started runs on in the background"
  const counts = new Map<string, number>()
  for (const { type } of subagentsOf(terminal)) {
    const kind = type || "subagent"
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  if (counts.size === 0) return undefined
  return [...counts].map(([kind, count]) => `${count} ${kind}`).join(", ")
}
