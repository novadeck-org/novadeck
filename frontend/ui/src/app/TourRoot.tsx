import type { TourHost } from "@novadeck/tour/tour-host"
import { TourProvider } from "@novadeck/tour/TourProvider"
import { useMemo, type ReactNode } from "react"

import { useWorkspaceServices } from "./controller/context"

/** The tour's provider, handed what it needs of the app: its backend, workspace and commands. */
export const TourRoot = ({ children }: { readonly children: ReactNode }): React.JSX.Element => {
  const { backend, workspace, commands } = useWorkspaceServices()
  const host = useMemo<TourHost>(
    () => ({ backend, workspace, commands }),
    [backend, workspace, commands],
  )
  return <TourProvider host={host}>{children}</TourProvider>
}
