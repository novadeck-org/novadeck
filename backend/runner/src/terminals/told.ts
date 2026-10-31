import type { Root } from "../harnesses/roots.js"
import type { AgentReport, Told } from "./saved-terminals.js"

type Agents = { readonly [agent in Root["agent"]]?: AgentReport }

/**
 * What the root session was told once and still holds (see `AgentReport.told`): kept with
 * its agent's report while that report is of the same session; nothing for another.
 */
export const toldOf = (agents: Agents, root: Root | null): Told => {
  if (!root) return {}
  const report = agents[root.agent]
  return report?.sessionId === root.sessionId ? (report.told ?? {}) : {}
}

/**
 * The reports with the root session's `told` changed by `change`, or as they were where
 * no report is of that session. An empty `told` is left out, as rows saved without one.
 */
export const retold = (agents: Agents, root: Root, change: (told: Told) => Told): Agents => {
  const report = agents[root.agent]
  if (report?.sessionId !== root.sessionId) return agents
  const { told: _, ...rest } = report
  const told = change(report.told ?? {})
  const kept = told.bar !== undefined || Object.keys(told.notes ?? {}).length > 0
  return { ...agents, [root.agent]: kept ? { ...rest, told } : rest }
}
