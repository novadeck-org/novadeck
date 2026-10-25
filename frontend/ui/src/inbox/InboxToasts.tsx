import type { InboxItem } from "@novadeck/core/inbox"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { NovaMark } from "@novadeck/toolkit/NovaLogo"
import { createToasts, ToastRegion } from "@novadeck/toolkit/Toast"
import { Folder, Terminal } from "lucide-react"
import { useEffect, useMemo } from "react"

import { focusSheetSoon } from "./inbox-dom"
import { icons } from "./inbox-icons"
import { useInboxContext } from "./InboxProvider"
import { toastText } from "./toast-text"

// What shows the Inbox's toasts: one per terminal.
export type ToastBoard = {
  // Shows the item's toast, replacing (in place, moved to the front) any its terminal shows.
  readonly show: (item: InboxItem) => void
  // Takes the terminal's toast away if it still shows that item.
  readonly close: (terminalId: string, itemId: string) => void
}

// One toast: the type's icon in its tone; who wants what, and how long ago; the ask, a
// command in mono; and where it comes from, the terminal at the left and the project at the
// right edge, which is never cut.
const InboxToast = ({
  item,
  now,
}: {
  readonly item: InboxItem
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

// The toasts of the Inbox's items that need the person while the app has their focus: it
// follows the Inbox by `follow` (the app's `watchInboxToasts`), which decides what rings and
// when on the board it's given, and draws them as a stack over the header's right end. A
// click on one shows the Inbox on its item; the pill that counts the rest shows the Inbox.
// Closing a toast or letting it run out leaves its item in the Inbox.
export const InboxToasts = ({
  follow,
  showInbox,
}: {
  // Rings the Inbox's toasts on the board until the returned stop.
  readonly follow: (board: ToastBoard) => () => void
  readonly showInbox: () => void
}): React.JSX.Element => {
  const { open, now } = useInboxContext()
  const toasts = useMemo(() => createToasts<InboxItem>(), [])
  useEffect(() => {
    // The item each terminal's toast shows.
    const shown = new Map<string, string>()
    const board: ToastBoard = {
      show: (item) => {
        shown.set(item.source.terminalId, item.id)
        toasts.show(item.source.terminalId, item)
      },
      close: (terminalId, itemId) => {
        if (shown.get(terminalId) !== itemId) return
        shown.delete(terminalId)
        toasts.close(terminalId)
      },
    }
    const stop = follow(board)
    return () => {
      stop()
      toasts.clear()
    }
  }, [follow, toasts])
  return (
    <ToastRegion
      toasts={toasts}
      label="Inbox"
      onSelect={(item, { keyboard }) => {
        showInbox()
        open(item.id)
        // From the keyboard, on to the sheet that opens, as from a row.
        if (keyboard) focusSheetSoon()
      }}
      onMore={showInbox}
      fannedLabel={(count) => `${count} more in the Inbox`}
    >
      {(item) => <InboxToast item={item} now={now} />}
    </ToastRegion>
  )
}
