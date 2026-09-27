import type { TerminalMetadata } from "../../model/types"
import {
  beginRename,
  changeDraft,
  endRename,
  renameAction,
  type RenameSession,
} from "../../terminals/rename-state"
import { currentContext, currentState, currentTarget } from "../selectors"
import type { CommandContext } from "./context"

export type RenameCommands = {
  // Saves any other rename in progress first.
  readonly startRename: (terminal: TerminalMetadata, origin: RenameSession["origin"]) => void
  readonly changeRenameDraft: (id: string, draft: string) => void
  readonly saveRename: (id: string) => void
  readonly cancelRename: (id: string) => void
  readonly finishRename: (rename: RenameSession, save: boolean) => void
  // The rename in progress in the current session, if any.
  readonly activeRename: () => RenameSession | null
}

export const createRenameCommands = ({
  ui,
  workspace,
}: Pick<CommandContext, "ui" | "workspace">): RenameCommands => {
  let request = 0
  const setRename = (change: (rename: RenameSession | null) => RenameSession | null): void =>
    void ui.update((state) => {
      const rename = change(state.rename)
      return rename === state.rename ? state : { ...state, rename }
    })
  const activeRename = (): RenameSession | null => {
    const { rename } = ui.getSnapshot()
    return rename?.context === currentContext(workspace.getSnapshot()) ? rename : null
  }
  const finishRename = (rename: RenameSession, save: boolean): void => {
    const action = renameAction(rename, save)
    if (action) workspace.dispatch(action)
    setRename((current) => endRename(current, rename))
  }
  const finishIf = (id: string, save: boolean): void => {
    const current = activeRename()
    if (current?.id === id) finishRename(current, save)
  }
  return {
    activeRename,
    finishRename,
    startRename: (terminal, origin) => {
      const current = activeRename()
      if (current?.id === terminal.id) return
      if (current) finishRename(current, true)
      const snapshot = workspace.getSnapshot()
      setRename(() =>
        beginRename(terminal, origin, {
          context: currentContext(snapshot),
          view: currentState(snapshot).view,
          target: currentTarget(snapshot),
          request: ++request,
        }),
      )
    },
    changeRenameDraft: (id, draft) =>
      setRename((current) =>
        changeDraft(current, currentContext(workspace.getSnapshot()), id, draft),
      ),
    saveRename: (id) => finishIf(id, true),
    cancelRename: (id) => finishIf(id, false),
  }
}
