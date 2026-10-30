import type { Item } from "@novadeck/core/items"
import type { TerminalKey } from "@novadeck/core/port"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"

// What the demo reads of the workspace it last saw.

// The terminal as the workspace last held it.
export const terminalOf = (
  workspace: Workspace | undefined,
  { projectId, workspaceSessionId, terminalId }: TerminalKey,
): TerminalMetadata | undefined =>
  workspace?.projects
    .find((project) => project.id === projectId)
    ?.history.find((session) => session.id === workspaceSessionId)
    ?.state.roster.terminals.find((terminal) => terminal.id === terminalId)

// The folder of a terminal's project.
export const directoryOf = (
  workspace: Workspace | undefined,
  key: { readonly projectId: string },
): string | undefined =>
  workspace?.projects.find((project) => project.id === key.projectId)?.directory

// Every item the workspace's sessions hold.
export const itemsOf = (workspace: Workspace): readonly Item[] =>
  workspace.projects.flatMap((project) => project.history.flatMap((each) => each.state.items))
