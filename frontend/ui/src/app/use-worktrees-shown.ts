import { createStore } from "@novadeck/core/store"
import { useLayoutEffect } from "react"

import { useUiState, useWorkspaceServices } from "./controller/context"
import { useStoreSelector } from "./controller/useStoreSelector"
import { reportsWorks } from "./routing"
import { updateShell } from "./ui-store"

// What a backend without the agent worktrees setting reads in its place: off.
const noWorktrees = createStore(false)

// Whether the sidebar shows the Worktrees panel and its toggle: where the backend reports the
// worktrees' work, and only while the person has agent worktrees on (Preferences →
// Experimental), which a stable build always turns off. A backend without that setting has none.
export const useWorktreesShown = (): boolean => {
  const { backend } = useWorkspaceServices()
  const worktreesOn = useStoreSelector(backend.worktrees?.enabled ?? noWorktrees, (on) => on)
  return reportsWorks(backend) && worktreesOn
}

// Leaves the Worktrees panel for Terminals while it isn't shown, before the sidebar paints it
// empty: at a launch whose URL names it, or when the person turns agent worktrees off while it
// is open.
// A step back to it goes too, so the open panel's toggle hides the sidebar instead.
export const useLeaveHiddenWorktrees = (shown: boolean): void => {
  const { navigation, ui } = useWorkspaceServices()
  const onWorktrees = useUiState((state) => state.location.route.panel === "worktrees")
  const backToWorktrees = useUiState((state) => state.shell.sidebarBack?.to === "worktrees")
  useLayoutEffect(() => {
    if (shown) return
    if (backToWorktrees) updateShell(ui, (shell) => ({ ...shell, sidebarBack: null }))
    if (onWorktrees) navigation.go({ panel: "terminals" }, true)
  }, [onWorktrees, backToWorktrees, shown, navigation, ui])
}
