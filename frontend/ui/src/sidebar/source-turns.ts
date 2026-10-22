import type { WorkspaceProject } from "@novadeck/core/types"

// When an agent's turn last ended in the project, in any of its sessions: the Source panel reads
// its folders again when this moves on, as an agent's turn is when its files changed. 0 for none.
export const latestTurnEnd = (project: WorkspaceProject): number =>
  Math.max(
    0,
    ...project.history.flatMap((session) =>
      session.state.roster.terminals.map((terminal) =>
        terminal.state === "running" ? (terminal.agent?.lastTurn?.at ?? 0) : 0,
      ),
    ),
  )
