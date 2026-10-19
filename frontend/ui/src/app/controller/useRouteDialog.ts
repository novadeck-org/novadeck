import { useCallback, useState } from "react"

import type { WorkspaceRoute } from "../routing"

export type RouteDialog = NonNullable<WorkspaceRoute["dialog"]>

// Retain only the outgoing dialog for its exit animation. The route determines
// which dialog opens next, including when Back/Forward interrupts a transition.
export const useRouteDialog = (requested: WorkspaceRoute["dialog"], context: string) => {
  const [presentation, setPresentation] = useState({ context, dialog: requested })
  const [loaded, setLoaded] = useState<Partial<Record<RouteDialog, true>>>({})
  // The dialog's deferred view has arrived and rendered.
  const onLoaded = useCallback(
    (dialog: RouteDialog): void =>
      setLoaded((previous) => (previous[dialog] ? previous : { ...previous, [dialog]: true })),
    [],
  )
  const present = presentation.dialog
  // A dialog whose view has not loaded yet never rendered open, so it has no exit to
  // wait for; the next requested dialog takes over at once.
  const unshown = present !== null && present !== requested && !loaded[present]
  // Both dialogs remount with the workspace, so no old exit callback can advance them.
  if (presentation.context !== context || (present === null && requested !== null) || unshown)
    setPresentation({ context, dialog: requested })
  return {
    searching: present === "search" && requested === "search",
    settings: present === "preferences" && requested === "preferences",
    onExitComplete: (): void => setPresentation({ context, dialog: requested }),
    onLoaded,
  }
}
