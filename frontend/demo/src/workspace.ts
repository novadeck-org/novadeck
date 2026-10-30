import type { Item } from "@novadeck/core/items"
import type { TerminalKey } from "@novadeck/core/port"
import type { TerminalMetadata, Workspace, WorkspaceSession } from "@novadeck/core/types"

// What the demo reads of the workspace it last saw.

// A session as the workspace last held it.
export const sessionOf = (
  workspace: Workspace | undefined,
  {
    projectId,
    workspaceSessionId,
  }: { readonly projectId: string; readonly workspaceSessionId: string },
): WorkspaceSession | undefined =>
  workspace?.projects
    .find((project) => project.id === projectId)
    ?.history.find((session) => session.id === workspaceSessionId)

// The terminal as the workspace last held it.
export const terminalOf = (
  workspace: Workspace | undefined,
  key: TerminalKey,
): TerminalMetadata | undefined =>
  sessionOf(workspace, key)?.state.roster.terminals.find(
    (terminal) => terminal.id === key.terminalId,
  )

// Every terminal of the workspace, in every session of every project, with its key.
export const terminalsOf = (
  workspace: Workspace,
): { key: TerminalKey; terminal: TerminalMetadata }[] =>
  workspace.projects.flatMap((project) =>
    project.history.flatMap((session) =>
      session.state.roster.terminals.map((terminal) => ({
        key: { projectId: project.id, workspaceSessionId: session.id, terminalId: terminal.id },
        terminal,
      })),
    ),
  )

// The folder of a terminal's project.
export const directoryOf = (
  workspace: Workspace | undefined,
  key: { readonly projectId: string },
): string | undefined =>
  workspace?.projects.find((project) => project.id === key.projectId)?.directory

// Every item the workspace's sessions hold.
export const itemsOf = (workspace: Workspace): readonly Item[] =>
  workspace.projects.flatMap((project) => project.history.flatMap((each) => each.state.items))
