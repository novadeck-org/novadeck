import { activeProject, activeSession } from "../model/state"
import type {
  TerminalMetadata,
  ViewMode,
  WindowedView,
  Workspace,
  WorkspaceState,
  WorkspaceTarget,
} from "../model/types"
import type { FocusPreview } from "../shell/shell-state"

// The active session's state; the workspace always has one once seeded.
export const currentState = (workspace: Workspace): WorkspaceState =>
  activeSession(workspace)!.state

// `${projectId}/${workspaceSessionId}`; presentation state is scoped to it.
export const currentContext = (workspace: Workspace): string =>
  `${workspace.activeProjectId}/${activeProject(workspace)!.activeSessionId}`

// What a person sees change on Back/Forward: the session, its view and its selection.
export const currentPresentation = (workspace: Workspace): string => {
  const { view, selected } = currentState(workspace)
  return `${currentContext(workspace)}/${view}/${selected}`
}

// Where commands for the active session are addressed.
export const currentTarget = (workspace: Workspace): WorkspaceTarget => ({
  projectId: workspace.activeProjectId,
  workspaceSessionId: activeProject(workspace)!.activeSessionId,
})

// Where Focus hands a terminal back to: the session's windowed view if enabled,
// otherwise the first enabled view that is not Focus.
export const windowedDestination = (
  windowedView: WindowedView,
  enabledViews: readonly ViewMode[],
): ViewMode | undefined =>
  enabledViews.includes(windowedView) ? windowedView : enabledViews.find((mode) => mode !== "focus")

export const sameTarget = (a: WorkspaceTarget, b: WorkspaceTarget): boolean =>
  a.projectId === b.projectId && a.workspaceSessionId === b.workspaceSessionId

// Equal when both hold the identical items in the same order.
export const sameItems = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((item, index) => Object.is(item, b[index]))

// Equal when both have the same keys holding identical values.
export const shallowEqual = <T>(a: T, b: T): boolean => {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.is(a[key as keyof T], b[key as keyof T]))
  )
}

// The terminal Focus shows: the selection, a kept preview, or the first terminal.
export const activeTerminal = (
  terminals: readonly TerminalMetadata[],
  selected: string,
  context: string,
  focusPreview: FocusPreview | null,
): TerminalMetadata | undefined => {
  const displayed = selected || (focusPreview?.context === context ? focusPreview.id : "")
  return terminals.find((terminal) => terminal.id === displayed) ?? terminals[0]
}
