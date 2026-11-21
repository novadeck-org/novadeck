import type { Store } from "@novadeck/core/store"
import type { TourHost, TourPreview } from "@novadeck/tour/tour-host"
import { TourProvider } from "@novadeck/tour/TourProvider"
import { useMemo, type ReactNode } from "react"

import { useWorkspaceServices } from "./controller/context"
import type { UiStore } from "./ui-store"

// The files open as a merged preview, read off the app's store; the list stays the same object
// until they change.
const previewsOf = (ui: UiStore): Store<readonly TourPreview[]> => {
  const read = (): readonly TourPreview[] =>
    Object.values(ui.getSnapshot().filePreviews).map(({ projectId, itemId, path }) => ({
      projectId,
      itemId,
      path,
    }))
  let source = ui.getSnapshot().filePreviews
  let list = read()
  return {
    subscribe: ui.subscribe,
    getSnapshot: () => {
      const now = ui.getSnapshot().filePreviews
      if (now !== source) {
        source = now
        list = read()
      }
      return list
    },
  }
}

/** The tour's provider, handed what it needs of the app: its backend, workspace and commands. */
export const TourRoot = ({ children }: { readonly children: ReactNode }): React.JSX.Element => {
  const { backend, workspace, commands, ui } = useWorkspaceServices()
  const previews = useMemo(() => previewsOf(ui), [ui])
  const host = useMemo<TourHost>(
    () => ({ backend, workspace, commands, previews }),
    [backend, workspace, commands, previews],
  )
  return <TourProvider host={host}>{children}</TourProvider>
}
