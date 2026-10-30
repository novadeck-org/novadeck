import { useCallback, useEffect, useMemo, type ReactNode } from "react"

import { AgentContextProvider } from "../inbox/agent-context"
import { InboxProvider, useInboxOpener } from "../inbox/InboxProvider"
import { InboxSheet } from "../inbox/InboxSheet"
import { InboxToasts, type ShowBoard, type ToastBoard } from "../inbox/InboxToasts"
import { PlanTextProvider } from "../inbox/plan-text"
import { focusTerminalInput } from "../interaction/dom"
import { anyAgentWorking } from "../projects/project-status"
import { useDesktop } from "../shell/desktop"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { dingOf } from "./ding"
import { clickNotice, noticeBoard } from "./inbox-pings"
import { watchInboxToasts } from "./inbox-toasts"
import { currentState } from "./selectors"
import { focusWhenReady, watchShowToasts } from "./show-toasts"

// The Inbox: the backend's, as it lands (see `inbox-landing.ts`), or, where the backend has
// none, one that lists nothing.

// Hears a click on a terminal's notification (see `clickNotice`).
const NoticeClicks = (): null => {
  const { backend, commands, landing, ui } = useWorkspaceServices()
  const opener = useInboxOpener()
  const { showInbox, reveal } = commands
  useEffect(
    () =>
      backend.notices?.onClick((terminalId) =>
        // The backend's rows, as the terminal being viewed may hold the one the notice is
        // about back from the Inbox: the click lands it before it opens.
        clickNotice(
          terminalId,
          backend.inbox?.state.getSnapshot().items ?? [],
          {
            open: (id) => opener?.((rows) => rows.find((row) => row.id === id)),
            showInbox,
            reveal,
            land: landing.reveal,
          },
          noticeBoard(backend.notices, dingOf(backend, ui))?.rowIdOf(terminalId),
        ),
      ),
    [backend, ui, landing, opener, showInbox, reveal],
  )
  return null
}

// Gives the app below it the backend's Inbox: its list, and the sheets that open beside
// it, which read the context of a row's agent from the backend's conversations and
// messages. The list is a sidebar panel (`shell/WorkspaceSidebar.tsx`); on a phone it and
// a sheet take the screen in turn, so the sidebar's drawer is shut while a sheet is open.
export const InboxHost = ({
  active,
  children,
}: {
  // Whether the sidebar shows the Inbox's panel.
  readonly active: boolean
  readonly children: ReactNode
}): React.JSX.Element => {
  const { backend, commands, landing, ui, workspace } = useWorkspaceServices()
  const desktop = useDesktop()
  const { inbox } = landing
  // Whether an agent is at work in any project, for the empty Inbox to say.
  const working = useWorkspaceState((state) => anyAgentWorking(state.projects))
  const { hideSidebar, toggleSidebar, reveal, select, showInbox } = commands
  const phone = useMemo(
    () => (desktop ? undefined : { hideList: hideSidebar, showList: () => toggleSidebar("inbox") }),
    [desktop, hideSidebar, toggleSidebar],
  )
  // Only a backend that shows notices has a ping to take a row held as the person leaves.
  const pings = backend.notices !== undefined
  const follow = useCallback(
    (board: ToastBoard) =>
      watchInboxToasts(inbox, ui, board, { pings, ding: dingOf(backend, ui).ring }),
    [inbox, ui, pings, backend],
  )
  // What an agent asked to show on a terminal the person isn't on, told as it waits to open.
  const followShows = useCallback(
    (board: ShowBoard) => watchShowToasts(workspace, ui, board),
    [workspace, ui],
  )
  // Brings the terminal a row waits on into view, as its sidebar row does where the session
  // is on screen, else as a click on a notification about it does.
  const showTerminal = useCallback(
    (terminalId: string) => {
      if (
        currentState(workspace.getSnapshot()).roster.terminals.some(
          (each) => each.id === terminalId,
        )
      )
        select(terminalId)
      else reveal(terminalId)
      // Typing goes where the person is looking, not to the terminal they left.
      focusWhenReady(terminalId, focusTerminalInput)
    },
    [workspace, select, reveal],
  )
  return (
    <AgentContextProvider conversations={backend.conversations} messages={backend.messages}>
      <InboxProvider inbox={inbox} reveal={reveal} phone={phone} working={working} active={active}>
        {children}
        <NoticeClicks />
        <PlanTextProvider workspace={workspace} companions={backend.companions}>
          <InboxSheet active={active} />
        </PlanTextProvider>
        <InboxToasts
          follow={follow}
          followShows={followShows}
          showInbox={showInbox}
          showTerminal={showTerminal}
        />
      </InboxProvider>
    </AgentContextProvider>
  )
}
