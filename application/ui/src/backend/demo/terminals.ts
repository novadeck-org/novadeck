import type { TerminalMetadata, Workspace } from "../../model/types"
import type { TerminalKey } from "../port"

// The terminal as the workspace last held it.
export const terminalOf = (
  workspace: Workspace | undefined,
  { projectId, workspaceSessionId, terminalId }: TerminalKey,
): TerminalMetadata | undefined =>
  workspace?.projects
    .find((project) => project.id === projectId)
    ?.history.find((session) => session.id === workspaceSessionId)
    ?.state.roster.terminals.find((terminal) => terminal.id === terminalId)
