import type { InboxRow } from "@novadeck/core/inbox"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { NovaMark } from "@novadeck/toolkit/NovaLogo"
import { createToasts, shownToasts, ToastRegion } from "@novadeck/toolkit/Toast"
import { Eye, Folder, Terminal } from "lucide-react"
import { useEffect, useMemo } from "react"

import { focusSheetSoon } from "./inbox-dom"
import { icons } from "./inbox-icons"
import { useInboxContext } from "./InboxProvider"
import { toastText } from "./toast-text"

// What shows the Inbox's toasts: one per terminal.
export type ToastBoard = {
  // Shows the item's toast, replacing (in place, moved to the front) any its terminal shows.
  readonly show: (item: InboxRow) => void
  // Takes the terminal's toast away if it still shows that item.
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
}

// What shows the toasts of what waits to open.
export type ShowBoard = {
  // Shows the item's toast, replacing its older one.
  readonly show: (waiting: ShowWaiting) => void
  // Takes the item's toast away, if it still shows.
  readonly close: (itemId: string) => void
}

// A toast is an Inbox item's, or an agent's wish to show something.
type Toast =
  | { readonly kind: "inbox"; readonly item: InboxRow }
  | { readonly kind: "show"; readonly waiting: ShowWaiting }

// What the pill past the shown toasts says: `count` toasts are hidden, `inbox` of them the
// Inbox's, which it says are in the Inbox; show toasts aren't, and aren't counted there.
export const moreWords = (count: number, inbox: number): string =>
  inbox > 0 ? `${inbox} more in the Inbox` : `${count} more`

// The key of an item's toast, apart from the terminals' keys of the Inbox's.
const showKey = (itemId: string): string => `show:${itemId}`

// One toast: the type's icon in its tone; who wants what, and how long ago; the ask, a
// command in mono; and where it comes from, the terminal at the left and the project at the
// right edge, which is never cut.
const InboxToast = ({
  item,
  now,
}: {
  readonly item: InboxRow
  readonly now: number
}): React.JSX.Element => {
  const text = toastText(item, now)
  const Icon = icons[text.type]
  return (
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
}

// What an agent asked to show on a terminal the person isn't on: who wants to show what, and
// the button that brings the terminal into view, whose pane then opens it. Quiet, like the
// Inbox's lines it sits among: no tone.
const ShowToast = ({
  waiting,
  open,
}: {
  readonly waiting: ShowWaiting
  readonly open: () => void
}): React.JSX.Element => (
  <div className="inbox-toast" data-type="update" data-tone="quiet">
    <span className="inbox-toast-icon" aria-hidden="true">
      <Eye size={15} strokeWidth={1.6} />
    </span>
    <span className="inbox-toast-head">
      <HandleChip handle={waiting.handle} />
      <span className="inbox-toast-name">{waiting.terminalName}</span>
      <span className="inbox-toast-said">wants to show you</span>
    </span>
    <span className="inbox-toast-subject">{waiting.itemName}</span>
    <span className="inbox-toast-foot">
      <Folder size={11} strokeWidth={1.8} aria-hidden="true" />
      <span className="inbox-toast-title">{waiting.projectName}</span>
      <button type="button" className="inbox-toast-open" onClick={open}>
        Open
      </button>
    </span>
  </div>
)

// The toasts of the Inbox's items that need the person while the app has their focus: it
// follows the Inbox by `follow` (the app's `watchInboxToasts`), which decides what rings and
// when on the board it's given, and draws them as a stack over the header's right end. A
// click on one shows the Inbox on its item; the pill that counts the rest shows the Inbox.
// Closing a toast or letting it run out leaves its item in the Inbox.
export const InboxToasts = ({
  follow,
  followShows,
  showInbox,
  showTerminal,
}: {
  // Rings the Inbox's toasts on the board until the returned stop.
  readonly follow: (board: ToastBoard) => () => void
  // Tells of what waits to open on the board until the returned stop.
  readonly followShows: (board: ShowBoard) => () => void
  readonly showInbox: () => void
  // Brings the terminal into view, selected, which opens what waits on it.
  readonly showTerminal: (terminalId: string) => void
}): React.JSX.Element => {
  const { open, now } = useInboxContext()
  const toasts = useMemo(() => createToasts<Toast>(), [])
  useEffect(() => {
    // The item each terminal's toast shows.
    const shown = new Map<string, string>()
    const board: ToastBoard = {
      show: (item) => {
        shown.set(item.source.terminalId, item.id)
        toasts.show(item.source.terminalId, { kind: "inbox", item })
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
    const stop = follow(board)
    const stopShows = followShows(shows)
    return () => {
      stop()
      stopShows()
      toasts.clear()
    }
  }, [follow, followShows, toasts])
  return (
    <ToastRegion
      toasts={toasts}
      label="Inbox"
      onSelect={(toast, { keyboard }) => {
        if (toast.kind === "show") return showTerminal(toast.waiting.terminalId)
        showInbox()
        open(toast.item.id)
        // From the keyboard, on to the sheet that opens, as from a row.
        if (keyboard) focusSheetSoon()
      }}
      onMore={showInbox}
      fannedLabel={(count) => {
        // What is past the shown few, the Inbox's own counted apart from what agents want to show.
        const { order, entries } = toasts.view.snapshot()
        const inbox = order
          .slice(shownToasts)
          .filter((id) => entries.get(id)?.data.kind === "inbox").length
        return moreWords(count, inbox)
      }}
    >
      {(toast) =>
        toast.kind === "show" ? (
          <ShowToast
            waiting={toast.waiting}
            open={() => {
              showTerminal(toast.waiting.terminalId)
              toasts.close(showKey(toast.waiting.itemId))
            }}
          />
        ) : (
          <InboxToast item={toast.item} now={now} />
        )
      }
    </ToastRegion>
  )
}
