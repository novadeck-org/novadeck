import { useCallback, useEffect, useMemo, type ReactNode } from "react"

import { AgentContextProvider } from "../inbox/agent-context"
import { InboxProvider, useInboxOpener } from "../inbox/InboxProvider"
import { InboxSheet } from "../inbox/InboxSheet"
import { InboxToasts, type MoveBoard, type ShowBoard, type ToastBoard } from "../inbox/InboxToasts"
import { PlanTextProvider } from "../inbox/plan-text"
import { focusTerminalInput } from "../interaction/dom"
import { anyAgentWorking } from "../projects/project-status"
import { useDesktop } from "../shell/desktop"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { dingOf } from "./ding"
import { clickNotice, noticeBoard } from "./inbox-pings"
import { watchInboxToasts } from "./inbox-toasts"
import { watchMoveToasts } from "./move-toasts"
import { currentState, modalOpen } from "./selectors"
import { focusWhenReady, watchShowToasts } from "./show-toasts"

// The Inbox: the backend's, as it lands (see `inbox-landing.ts`), or, where the backend has
// none, one that lists nothing.

// Hears a click on a terminal's notification (see `clickNotice`).
const NoticeClicks = (): null => {
  const { backend, commands, ui } = useWorkspaceServices()
  const opener = useInboxOpener()
  const { peekInbox, reveal } = commands
  useEffect(
    () =>
      backend.notices?.onClick((terminalId) =>
        // The backend's rows, as the Inbox may hold the row back.
        clickNotice(
          terminalId,
          backend.inbox?.state.getSnapshot().items ?? [],
          {
            open: (id, after) => opener?.((rows) => rows.find((row) => row.id === id), { after }),
            peekInbox,
            reveal,
          },
          noticeBoard(backend.notices, dingOf(backend, ui))?.rowIdOf(terminalId),
        ),
      ),
    [backend, ui, opener, peekInbox, reveal],
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
  // Whether the person looks at the page, for an update's row in sight to count as seen.
  const looking = useUiState((state) => state.pageFocused && !modalOpen(state))
  const { hideSidebar, reveal, select, showInbox, peekInbox } = commands
  const phone = useMemo(
    () => (desktop ? undefined : { hideList: hideSidebar, showList: showInbox }),
    [desktop, hideSidebar, showInbox],
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
  // The person's moves, each told once it's done, with Undo and the way there.
  const followMoves = useCallback(
    (board: MoveBoard) => watchMoveToasts(ui, board, commands),
    [ui, commands],
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
  // Going to an Inbox row's terminal from the Inbox's list turns the sidebar to the terminals.
  const revealItem = useCallback(
    (terminalId: string) => reveal(terminalId, active ? "terminals" : undefined),
    [reveal, active],
  )
  return (
    <AgentContextProvider
      conversations={backend.conversations}
      messages={backend.messages}
      openLogs={backend.openLogs}
    >
      <InboxProvider
        inbox={inbox}
        reveal={revealItem}
        phone={phone}
        working={working}
        active={active}
        looking={looking}
      >
        {children}
        <NoticeClicks />
        <PlanTextProvider workspace={workspace} companions={backend.companions}>
          <InboxSheet active={active} />
        </PlanTextProvider>
        <InboxToasts
          follow={follow}
          followShows={followShows}
          followMoves={followMoves}
          showInbox={showInbox}
          peekInbox={peekInbox}
          showTerminal={showTerminal}
        />
      </InboxProvider>
    </AgentContextProvider>
  )
}
