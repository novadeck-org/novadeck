import { createStore } from "@novadeck/core/store"
import { useEffect } from "react"

import { useUiState, useWorkspaceServices } from "./controller/context"
import { useStoreSelector } from "./controller/useStoreSelector"
import { worksShown } from "./routing"

// What a backend without the agent worktrees setting reads in its place: off.
const noWorktrees = createStore(false)

// Whether the sidebar shows the Changes panel and its toggle: where the backend reports the
// terminals' work, and only while the person has agent worktrees on (Preferences →
// Experimental), which a stable build always turns off. A backend without that setting has none.
export const useChangesShown = (): boolean => {
  const { backend } = useWorkspaceServices()
  const worktreesOn = useStoreSelector(backend.worktrees?.enabled ?? noWorktrees, (on) => on)
  return worksShown(backend) && worktreesOn
}

// Leaves the Changes panel for Terminals while it isn't shown: at a launch whose URL names it, or
// when the person turns agent worktrees off while it is open.
export const useLeaveHiddenChanges = (shown: boolean): void => {
  const { navigation } = useWorkspaceServices()
  const onChanges = useUiState((state) => state.location.route.panel === "changes")
  useEffect(() => {
    if (onChanges && !shown) navigation.go({ panel: "terminals" }, true)
  }, [onChanges, shown, navigation])
}
