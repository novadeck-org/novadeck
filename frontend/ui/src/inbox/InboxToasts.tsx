import type { InboxRow } from "@novadeck/core/inbox"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { NovaMark } from "@novadeck/toolkit/NovaLogo"
import { createToasts, shownToasts, ToastRegion } from "@novadeck/toolkit/Toast"
import { ArrowRightLeft, Eye, Folder, Terminal, type LucideIcon } from "lucide-react"
import { useEffect, useMemo } from "react"

import { focusSheetSoon } from "./inbox-dom"
import { icons } from "./inbox-icons"
import { waitLabel } from "./inbox-text"
import { useInboxContext } from "./InboxProvider"
import { toastText, type ToastText } from "./toast-text"

// What shows the Inbox's toasts: one per terminal.
export type ToastBoard = {
  // Shows the row's toast, replacing (in place, moved to the front) any its terminal shows.
  readonly show: (row: InboxRow) => void
  // Takes the terminal's toast away if it still shows that row.
  readonly close: (terminalId: string, itemId: string) => void
}

// What an agent asked to show that waits for the person to select its terminal: who wants to
// show what, and the version of it, so one shown again is told again.
export type ShowWaiting = {
  readonly itemId: string
  readonly version: number
  readonly itemName: string
  readonly terminalId: string
  readonly terminalName: string
  readonly handle: string | undefined
  readonly projectName: string
  // When the agent showed it, for the toast's age.
  readonly at: number
}

// What shows the toasts of what waits to open.
export type ShowBoard = {
  // Shows the row's toast, replacing its older one.
  readonly show: (waiting: ShowWaiting) => void
  // Takes the row's toast away, if it still shows.
  readonly close: (itemId: string) => void
}

// A terminal the person moved to another session: what the toast says, and whether it can
// be taken back.
export type MovedToast = {
  readonly id: string
  readonly words: string
  readonly failed: boolean
  readonly undo: (() => void) | undefined
  readonly go: () => void
}

// What shows the toast of a move: one at a time, the newest replacing the last.
export type MoveBoard = {
  readonly show: (moved: MovedToast) => void
  readonly close: () => void
}

// A toast is an Inbox row's, an agent's wish to show something, or a move the person made.
type Toast =
  | { readonly kind: "inbox"; readonly row: InboxRow }
  | { readonly kind: "show"; readonly waiting: ShowWaiting }
  | { readonly kind: "moved"; readonly moved: MovedToast }

// What the pill past the shown toasts says: `count` toasts are hidden, `inbox` of them the
// Inbox's, which it says are in the Inbox; show toasts aren't, and aren't counted there.
export const moreWords = (count: number, inbox: number): string =>
  inbox > 0 ? `${inbox} more in the Inbox` : `${count} more`

// The key of a row's toast, apart from the terminals' keys of the Inbox's.
const showKey = (itemId: string): string => `show:${itemId}`
const movedKey = "moved"

// A move's toast: where the terminal went and that it still runs, or why it couldn't go, and
// Undo and Go there. A click on the toast goes there too; its buttons' own clicks don't.
const MovedCard = ({ moved }: { readonly moved: MovedToast }): React.JSX.Element => (
  <div className="move-toast" data-failed={moved.failed}>
    <span className="move-toast-icon" aria-hidden="true">
      <ArrowRightLeft size={15} strokeWidth={1.6} />
    </span>
    <span className="move-toast-words">{moved.words}</span>
    {moved.undo && (
      <span className="move-toast-actions">
        <button
          type="button"
          className="button quiet move-toast-undo"
          onClick={(event) => {
            event.stopPropagation()
            moved.undo?.()
          }}
        >
          Undo
        </button>
        <button
          type="button"
          className="button quiet move-toast-go"
          onClick={(event) => {
            event.stopPropagation()
            moved.go()
          }}
        >
          Go there
        </button>
      </span>
    )}
  </div>
)

// One toast: the type's icon in its tone; who wants what, and how long ago; the ask, a
// command in mono; and where it comes from, the terminal at the left and the project at the
// right edge, which is never cut.
const ToastCard = ({
  text,
  Icon,
}: {
  readonly text: ToastText
  readonly Icon: LucideIcon
}): React.JSX.Element => (
  <div className="inbox-toast" data-type={text.type} data-tone={text.tone}>
    <span className="inbox-toast-icon" aria-hidden="true">
      <Icon size={15} strokeWidth={1.6} />
    </span>
    <span className="inbox-toast-head">
      {text.novadeck ? <NovaMark size={12} /> : <HandleChip handle={text.handle} />}
      <span className="inbox-toast-said">{text.said}</span>
    </span>
    <span className="inbox-toast-age">{text.age}</span>
    <span className="inbox-toast-subject" data-command={text.command !== null}>
      {text.command ?? text.subject}
    </span>
    <span className="inbox-toast-foot">
      <Terminal size={11} strokeWidth={1.8} aria-hidden="true" />
      <span className="inbox-toast-title">{text.title}</span>
      <span className="inbox-toast-project">
        <Folder size={11} strokeWidth={1.8} aria-hidden="true" />
        {text.project}
      </span>
    </span>
  </div>
)

// An Inbox row's toast, in the Inbox's own words.
const InboxToast = ({
  row,
  now,
}: {
  readonly row: InboxRow
  readonly now: number
}): React.JSX.Element => {
  const text = toastText(row, now)
  return <ToastCard text={text} Icon={icons[text.type]} />
}

// What a toast says of what an agent wants to show on a terminal the person isn't on, in
// the Inbox toasts' words: quiet, like the updates it sits among.
const showText = (waiting: ShowWaiting, now: number): ToastText => ({
  type: "update",
  tone: "quiet",
  handle: waiting.handle,
  novadeck: false,
  said: "wants to show you",
  command: null,
  subject: waiting.itemName,
  age: waitLabel(waiting.at, now),
  title: waiting.terminalName,
  project: waiting.projectName,
})

// The toasts of the Inbox's rows that need the person while the app has their focus: it
// follows the Inbox by `follow` (the app's `watchInboxToasts`), which decides what rings and
// when on the board it's given, and draws them as a stack over the header's right end. A
// click on one shows the Inbox on its row, for that row alone: once it is answered the sidebar
// goes back to what it showed (`peekInbox`). The pill that counts the rest shows the Inbox.
// Closing a toast or letting it run out leaves its row in the Inbox.
export const InboxToasts = ({
  follow,
  followShows,
  followMoves,
  showInbox,
  peekInbox,
  showTerminal,
}: {
  // Rings the Inbox's toasts on the board until the returned stop.
  readonly follow: (board: ToastBoard) => () => void
  // Tells of what waits to open on the board until the returned stop.
  readonly followShows: (board: ShowBoard) => () => void
  // Tells of the person's moves on the board until the returned stop.
  readonly followMoves: (board: MoveBoard) => () => void
  readonly showInbox: () => void
  // Shows the Inbox for one row; returns what puts the sidebar back, unless it showed already.
  readonly peekInbox: () => (() => void) | undefined
  // Brings the terminal into view, selected, which opens what waits on it.
  readonly showTerminal: (terminalId: string) => void
}): React.JSX.Element => {
  const { open, now } = useInboxContext()
  const toasts = useMemo(() => createToasts<Toast>(), [])
  useEffect(() => {
    // The row each terminal's toast shows.
    const shown = new Map<string, string>()
    const board: ToastBoard = {
      show: (row) => {
        shown.set(row.source.terminalId, row.id)
        toasts.show(row.source.terminalId, { kind: "inbox", row })
      },
      close: (terminalId, itemId) => {
        if (shown.get(terminalId) !== itemId) return
        shown.delete(terminalId)
        toasts.close(terminalId)
      },
    }
    const shows: ShowBoard = {
      show: (waiting) => toasts.show(showKey(waiting.itemId), { kind: "show", waiting }),
      close: (itemId) => toasts.close(showKey(itemId)),
    }
    const moves: MoveBoard = {
      show: (moved) => toasts.show(movedKey, { kind: "moved", moved }),
      close: () => toasts.close(movedKey),
    }
    const stop = follow(board)
    const stopShows = followShows(shows)
    const stopMoves = followMoves(moves)
    return () => {
      stop()
      stopShows()
      stopMoves()
      toasts.clear()
    }
  }, [follow, followShows, followMoves, toasts])
  return (
    <ToastRegion
      toasts={toasts}
      label="Inbox"
      onSelect={(toast, { keyboard }) => {
        if (toast.kind === "show") return showTerminal(toast.waiting.terminalId)
        if (toast.kind === "moved") return toast.moved.failed ? undefined : toast.moved.go()
        open(toast.row.id, { once: true, after: peekInbox() })
        // From the keyboard, on to the sheet that opens, as from a row.
        if (keyboard) focusSheetSoon()
      }}
      onMore={showInbox}
      spreadLabel={(count) => {
        // What is past the shown few, the Inbox's own counted apart from what agents want to show.
        const { order, entries } = toasts.view.snapshot()
        const inbox = order
          .slice(shownToasts)
          .filter((id) => entries.get(id)?.data.kind === "inbox").length
        return moreWords(count, inbox)
      }}
    >
      {(toast) =>
        toast.kind === "moved" ? (
          <MovedCard moved={toast.moved} />
        ) : toast.kind === "show" ? (
          <ToastCard text={showText(toast.waiting, now)} Icon={Eye} />
        ) : (
          <InboxToast row={toast.row} now={now} />
        )
      }
    </ToastRegion>
  )
}
