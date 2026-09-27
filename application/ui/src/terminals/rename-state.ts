import type { WorkspaceAction } from "../model/state"
import type { TerminalMetadata, ViewMode, WorkspaceTarget } from "../model/types"
import type { TerminalRename } from "./TerminalRenameInput"

// An in-progress rename, scoped to the session and view it started in.
export type RenameSession = {
  readonly context: string
  readonly id: string
  readonly original: string
  readonly draft: string
  readonly origin: "sidebar" | "header"
  readonly view: ViewMode
  readonly target: WorkspaceTarget
  // Distinguishes renames of the same terminal, so an old one cannot end a newer one.
  readonly request: number
}

export type RenameScope = Pick<RenameSession, "context" | "view" | "target" | "request">

export const beginRename = (
  terminal: TerminalMetadata,
  origin: RenameSession["origin"],
  scope: RenameScope,
): RenameSession => ({
  ...scope,
  id: terminal.id,
  original: terminal.name,
  draft: terminal.name,
  origin,
})

export const changeDraft = (
  rename: RenameSession | null,
  context: string,
  id: string,
  draft: string,
): RenameSession | null =>
  rename?.context === context && rename.id === id ? { ...rename, draft } : rename

// The commit that saves a rename, or null when it keeps the name.
export const renameAction = (rename: RenameSession, save: boolean): WorkspaceAction | null => {
  const name = rename.draft.trim()
  return save && name && name !== rename.original
    ? { type: "terminal/rename", target: rename.target, terminalId: rename.id, name }
    : null
}

// Ends `ended` if it is still the current rename.
export const endRename = (
  current: RenameSession | null,
  ended: RenameSession,
): RenameSession | null => (current?.request === ended.request ? null : current)

// What a tab or frame shows for the rename in progress.
export const renameView = (rename: RenameSession | null): TerminalRename | null =>
  rename
    ? { id: rename.id, value: rename.draft, request: rename.request, origin: rename.origin }
    : null
