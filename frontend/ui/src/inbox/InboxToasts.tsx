import type { InboxEntry } from "@novadeck/core/inbox"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { NovaMark } from "@novadeck/toolkit/NovaLogo"
import { createToasts, shownToasts, ToastRegion } from "@novadeck/toolkit/Toast"
import { ArrowRightLeft, Eye, Folder, Info, Terminal, type LucideIcon } from "lucide-react"
import { useEffect, useMemo } from "react"

import { focusSheetSoon } from "./inbox-dom"
import { iconOf } from "./inbox-icons"
import { waitLabel } from "./inbox-text"
import { useInboxContext } from "./InboxProvider"
import { toastText, type ToastText } from "./toast-text"

// What shows the Inbox's toasts: one per terminal.
export type ToastBoard = {
  // Shows the entry's toast, replacing (in place, moved to the front) any its terminal shows.
  readonly show: (entry: InboxEntry) => void
  // Takes the terminal's toast away if it still shows that entry.
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
  // Shows the entry's toast, replacing its older one.
  readonly show: (waiting: ShowWaiting) => void
  // Takes the entry's toast away, if it still shows.
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

// What Novadeck tells of something done elsewhere: what happened, and where that leaves the
// person. One at a time, the newest replacing the last; a click takes it away.
export type ToldToast = { readonly id: string; readonly said: string; readonly subject: string }
export type ToldBoard = {
  readonly show: (told: ToldToast) => void
  readonly close: () => void
}

// A toast is an Inbox entry's, an agent's wish to show something, a move the person made, or
// what Novadeck tells of something done elsewhere.
type Toast =
  | { readonly kind: "inbox"; readonly entry: InboxEntry }
  | { readonly kind: "show"; readonly waiting: ShowWaiting }
  | { readonly kind: "moved"; readonly moved: MovedToast }
  | { readonly kind: "told"; readonly told: ToldToast }

const toldText = (told: ToldToast): ToastText => ({
  type: "update",
  tint: "muted",
  handle: undefined,
  novadeck: true,
  said: told.said,
  command: null,
  subject: told.subject,
  age: "now",
  title: "",
  project: "",
})

// What the pill past the shown toasts says: `count` toasts are hidden, `inbox` of them the
// Inbox's, which it says are in the Inbox; show toasts aren't, and aren't counted there.
export const moreWords = (count: number, inbox: number): string =>
  inbox > 0 ? `${inbox} more in the Inbox` : `${count} more`

// The key of an entry's toast, apart from the terminals' keys of the Inbox's.
const showKey = (itemId: string): string => `show:${itemId}`
const movedKey = "moved"
const toldKey = "told"

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

// One toast: the kind's icon in its tint; who wants what, and how long ago; the ask, a
// command in mono; and where it comes from, the terminal at the left and the project at the
// right edge, which is never cut.
const ToastCard = ({
  text,
  Icon,
}: {
  readonly text: ToastText
  readonly Icon: LucideIcon
}): React.JSX.Element => (
  <div className="inbox-toast" data-type={text.type} data-tint={text.tint}>
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
    {/* Where it is: a terminal and its project; Novadeck's word of something elsewhere has none. */}
    {(text.title || text.project) && (
      <span className="inbox-toast-foot">
        <Terminal size={11} strokeWidth={1.8} aria-hidden="true" />
        <span className="inbox-toast-title">{text.title}</span>
        <span className="inbox-toast-project">
          <Folder size={11} strokeWidth={1.8} aria-hidden="true" />
          {text.project}
        </span>
      </span>
    )}
  </div>
)

// An Inbox entry's toast, in the Inbox's own words.
const InboxToast = ({
  entry,
  now,
}: {
  readonly entry: InboxEntry
  readonly now: number
}): React.JSX.Element => {
  const text = toastText(entry, now)
  return <ToastCard text={text} Icon={iconOf(entry)} />
}

// What a toast says of what an agent wants to show on a terminal the person isn't on, in
// the Inbox toasts' words: quiet, like the updates it sits among.
const showText = (waiting: ShowWaiting, now: number): ToastText => ({
  type: "update",
  tint: "muted",
  handle: waiting.handle,
  novadeck: false,
  said: "wants to show you",
  command: null,
  subject: waiting.itemName,
  age: waitLabel(waiting.at, now),
  title: waiting.terminalName,
  project: waiting.projectName,
})

// The toasts of the Inbox's entries that need the person while the app has their focus: it
// follows the Inbox by `follow` (the app's `watchInboxToasts`), which decides what rings and
// when on the board it's given, and draws them as a stack over the header's right end. A
// click on one shows the Inbox on its entry, for that entry alone: once it is answered the sidebar
// goes back to what it showed (`peekInbox`). The pill that counts the rest shows the Inbox.
// Closing a toast or letting it run out leaves its entry in the Inbox.
export const InboxToasts = ({
  follow,
  followShows,
  followMoves,
  followTold,
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
  // Tells what Novadeck says of something done elsewhere on the board until the returned stop.
  readonly followTold: (board: ToldBoard) => () => void
  readonly showInbox: () => void
  // Shows the Inbox for one entry; returns what puts the sidebar back, unless it showed already.
  readonly peekInbox: () => (() => void) | undefined
  // Brings the terminal into view, selected, which opens what waits on it.
  readonly showTerminal: (terminalId: string) => void
}): React.JSX.Element => {
  const { open, now } = useInboxContext()
  const toasts = useMemo(() => createToasts<Toast>(), [])
  useEffect(() => {
    // The entry each terminal's toast shows.
    const shown = new Map<string, string>()
    const board: ToastBoard = {
      show: (entry) => {
        shown.set(entry.source.terminalId, entry.id)
        toasts.show(entry.source.terminalId, { kind: "inbox", entry })
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
    const told: ToldBoard = {
      show: (said) => toasts.show(toldKey, { kind: "told", told: said }),
      close: () => toasts.close(toldKey),
    }
    const stopTold = followTold(told)
    return () => {
      stop()
      stopShows()
      stopMoves()
      stopTold()
      toasts.clear()
    }
  }, [follow, followShows, followMoves, followTold, toasts])
  return (
    <ToastRegion
      toasts={toasts}
      label="Inbox"
      onSelect={(toast, { keyboard }) => {
        if (toast.kind === "show") return showTerminal(toast.waiting.terminalId)
        if (toast.kind === "moved") return toast.moved.failed ? undefined : toast.moved.go()
        if (toast.kind === "told") return toasts.close(toldKey)
        open(toast.entry.id, { once: true, after: peekInbox() })
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
        ) : toast.kind === "told" ? (
          <ToastCard text={toldText(toast.told)} Icon={Info} />
        ) : toast.kind === "show" ? (
          <ToastCard text={showText(toast.waiting, now)} Icon={Eye} />
        ) : (
          <InboxToast entry={toast.entry} now={now} />
        )
      }
    </ToastRegion>
  )
}
