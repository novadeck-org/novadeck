import { useMemo, type ReactNode } from "react"

import { InboxProvider } from "../inbox/InboxProvider"
import { InboxSheet } from "../inbox/InboxSheet"
import { useDesktop } from "../shell/desktop"
import { useWorkspaceServices } from "./controller/context"

// The Inbox, where the backend has one: the capability read as other optional ones are,
// from the backend the app runs on. Without one there is nothing here.

// Gives the app below it the backend's Inbox: its list, and the sheets that open beside
// it. The list is a sidebar panel (`shell/WorkspaceSidebar.tsx`); on a phone it and a
// sheet take the screen in turn, so the sidebar's drawer is shut while a sheet is open.
export const InboxHost = ({
  active,
  children,
}: {
  // Whether the sidebar shows the Inbox's panel.
  readonly active: boolean
  readonly children: ReactNode
}): React.JSX.Element => {
  const { backend, commands } = useWorkspaceServices()
  const desktop = useDesktop()
  const { inbox } = backend
  const { hideSidebar, toggleSidebar, reveal } = commands
  const phone = useMemo(
    () => (desktop ? undefined : { hideList: hideSidebar, showList: () => toggleSidebar("inbox") }),
    [desktop, hideSidebar, toggleSidebar],
  )
  if (!inbox) return <>{children}</>
  return (
    <InboxProvider inbox={inbox} reveal={reveal} phone={phone}>
      {children}
      <InboxSheet active={active} />
    </InboxProvider>
  )
}
