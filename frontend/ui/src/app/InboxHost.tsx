import { useCallback, useEffect, useMemo, type ReactNode } from "react"

import { InboxProvider, useInboxOpener } from "../inbox/InboxProvider"
import { InboxSheet } from "../inbox/InboxSheet"
import { InboxToasts, type ToastBoard } from "../inbox/InboxToasts"
import { anyAgentWorking } from "../projects/project-status"
import { useDesktop } from "../shell/desktop"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { landedInbox, revealItem } from "./inbox-landing"
import { clickNotice, noticeBoard } from "./inbox-pings"
import { watchInboxToasts } from "./inbox-toasts"

// The Inbox: the backend's, as it lands (see `inbox-landing.ts`), or, where the backend has
// none, one that lists nothing.

// Hears a click on a terminal's notification (see `clickNotice`).
const NoticeClicks = (): null => {
  const { backend, commands } = useWorkspaceServices()
  const opener = useInboxOpener()
  const { showInbox, reveal } = commands
  useEffect(
    () =>
      backend.notices?.onClick((terminalId) =>
        // The backend's items, as the terminal being viewed may hold the one the notice is
        // about back from the Inbox: the click lands it before it opens.
        clickNotice(
          terminalId,
          backend.inbox?.state.getSnapshot().items ?? [],
          {
            open: (id) => opener?.((items) => items.find((item) => item.id === id)),
            showInbox,
            reveal,
            land: (id) => revealItem(backend.inbox, id),
          },
          noticeBoard(backend.notices)?.itemOf(terminalId),
        ),
      ),
    [backend, opener, showInbox, reveal],
  )
  return null
}

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
  const { backend, commands, ui, workspace } = useWorkspaceServices()
  const desktop = useDesktop()
  const inbox = landedInbox(backend.inbox, workspace, ui)
  // Whether an agent is at work in any project, for the empty Inbox to say.
  const working = useWorkspaceState((state) => anyAgentWorking(state.projects))
  const { hideSidebar, toggleSidebar, reveal, showInbox } = commands
  const phone = useMemo(
    () => (desktop ? undefined : { hideList: hideSidebar, showList: () => toggleSidebar("inbox") }),
    [desktop, hideSidebar, toggleSidebar],
  )
  // Only a host that shows notices has a ping to take an item held as the person leaves.
  const pings = backend.notices !== undefined
  const follow = useCallback(
    (board: ToastBoard) => watchInboxToasts(inbox, ui, board, { pings }),
    [inbox, ui, pings],
  )
  return (
    <InboxProvider
      inbox={inbox}
      reveal={reveal}
      phone={phone}
      working={working}
      feedbackAbout={backend.feedback?.about}
    >
      {children}
      <NoticeClicks />
      <InboxSheet active={active} />
      <InboxToasts follow={follow} showInbox={showInbox} />
    </InboxProvider>
  )
}
