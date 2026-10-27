import { inboxType, type InboxRow } from "@novadeck/core/inbox"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { Sheet } from "@novadeck/toolkit/Sheet"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { ArrowLeft, CircleCheck, Terminal, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { ApproveSheet } from "./ApproveSheet"
import { AskSheet } from "./AskSheet"
import { FeedbackSheet } from "./FeedbackSheet"
import { nextRowButton, rowOf, sheetControls } from "./inbox-dom"
import { icons } from "./inbox-icons"
import { nextItem } from "./inbox-state"
import { standingOf, toneOf } from "./inbox-text"
import { useInboxContext } from "./InboxProvider"
import type { SheetContentProps } from "./Page"
import { TroubleSheet } from "./TroubleSheet"
import { UpdateSheet } from "./UpdateSheet"

// What the sheet sits within: the workspace beside the sidebar.
const workspace = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(".workspace-main-pane")

// One item's sheet: its title bar, then the page of its type.
const SheetBody = ({ item }: { readonly item: InboxRow }): React.JSX.Element => {
  const { state, sent, now, phone, next, close, submit, change, reveal } = useInboxContext()
  const answered = sent[item.id]
  const failed = state.failed[item.id]
  const present = state.items.some((each) => each.id === item.id)
  const unavailable = item.kind === "ask" && failed !== undefined && !present
  // An answer that didn't take is no answer.
  const confirmed =
    failed === undefined && !state.answering[item.id] && !present ? answered : undefined
  const type = inboxType(item)
  const Icon = confirmed ? CircleCheck : icons[type]
  const content: SheetContentProps = {
    item,
    standing: unavailable
      ? { status: "reply not delivered", tone: "urgent" }
      : standingOf(item, now, confirmed !== undefined),
    sent: confirmed,
    answering: Boolean(state.answering[item.id]) || unavailable,
    failed,
    onNext: nextItem(state.items, item.id, state) ? next : undefined,
    submit: (answer, note) => submit(item, answer, note),
    change: (answer) => change(item, answer),
    reveal: () => reveal(item),
  }
  const { source } = item
  const leave = phone ? "Back to the Inbox" : "Close"
  return (
    <div
      className="inbox-sheet"
      data-type={type}
      data-state={confirmed ? "answered" : item.stopped ? "waiting" : "asking"}
      data-urgency={toneOf(item)}
      // Tab leaves the sheet the way it came: back to its row from the first control, and on
      // to the row after it from the last, so keyboard focus never falls out to the workspace.
      onKeyDown={(event) => {
        if (event.key !== "Tab" || phone) return
        const page = sheetControls(event.currentTarget)
        const head = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(".inbox-sheet-head button"),
        )
        // Tab order inside the sheet is the title bar, then its page.
        const order = [...head, ...page]
        const active = document.activeElement
        if (
          event.shiftKey &&
          (active === order[0] || active?.classList.contains("inbox-sheet-title"))
        ) {
          event.preventDefault()
          rowOf(item.id)?.querySelector<HTMLElement>(".inbox-row-select")?.focus()
        } else if (!event.shiftKey && active === order.at(-1)) {
          const following = nextRowButton(item.id)
          // With no row after it, Tab goes on past the list and the sheet closes.
          if (following) {
            event.preventDefault()
            following.focus()
          } else close()
        }
      }}
    >
      <header className="inbox-sheet-head">
        <span className="inbox-sheet-icon" aria-hidden="true">
          <Icon size={14} />
        </span>
        <h2 className="inbox-sheet-title text-body" tabIndex={-1}>
          {source.title}
        </h2>
        <span className="inbox-sheet-meta text-caption">
          {source.projectName} · {source.agent} · <HandleChip handle={source.handle} />
        </span>
        <Tooltip content="Show terminal">
          <button
            type="button"
            className="icon-button dim size-7"
            aria-label="Show terminal"
            onClick={content.reveal}
          >
            <Terminal size={14} strokeWidth={1.6} />
          </button>
        </Tooltip>
        <Tooltip content={leave}>
          <button
            type="button"
            className="icon-button dim size-7"
            aria-label={leave}
            onClick={close}
          >
            {phone ? <ArrowLeft size={14} strokeWidth={1.6} /> : <X size={14} strokeWidth={1.6} />}
          </button>
        </Tooltip>
      </header>
      {/* By what the item is, not its type alone: an ask that wants an action (a sign-in) is an
          Unblock but still takes the ask page, with its Do dialog. */}
      {(type === "ask" || item.kind === "ask") && <AskSheet {...content} />}
      {type === "unblock" && item.kind !== "ask" && <ApproveSheet {...content} />}
      {type === "trouble" && <TroubleSheet {...content} />}
      {type === "update" && <UpdateSheet {...content} />}
      {type === "feedback" && <FeedbackSheet {...content} />}
    </div>
  )
}

// The open item's sheet: beside its row over the workspace, or on a screen of its own.
// `active` is whether the Inbox is the panel the sidebar shows.
export const InboxSheet = ({ active }: { readonly active: boolean }): React.JSX.Element | null => {
  const { view, current, phone, close } = useInboxContext()
  // What it last showed, which it keeps while it closes.
  const [last, setLast] = useState(current)
  if (current && current !== last) setLast(current)
  const item = current ?? last
  const open = view.open !== null && current !== undefined && (phone || active)
  // With the list out of sight there is no row for a sheet to sit beside.
  useEffect(() => {
    if (!active && !phone) close()
  }, [active, phone, close])
  // The workspace steps back while a sheet is read over it, and is still live: a click in
  // it closes the sheet.
  useEffect(() => {
    workspace()?.setAttribute("data-inbox-reading", String(open && !phone))
  }, [open, phone])
  useEffect(() => () => workspace()?.removeAttribute("data-inbox-reading"), [])
  // On a screen of its own, focus goes into it as it opens.
  const screen = useRef<HTMLDivElement>(null)
  const opened = phone && open
  useEffect(() => {
    if (!opened) return
    // The page behind goes inert, so focus stays in the sheet; it comes back on closing.
    const page = document.querySelector<HTMLElement>("main.workspace")
    if (page) page.inert = true
    screen.current?.focus()
    return () => {
      if (page) page.inert = false
    }
  }, [opened])
  if (!item) return null
  if (phone)
    return open ? (
      <div
        ref={screen}
        className="inbox-fullscreen"
        role="dialog"
        aria-modal="true"
        aria-label={item.source.title}
        tabIndex={-1}
      >
        <SheetBody key={item.id} item={item} />
      </div>
    ) : null
  return (
    <Sheet
      label={item.source.title}
      open={open}
      anchor={() => rowOf(item.id)}
      boundary={workspace}
      anchorKey={item.id}
      onDismiss={close}
      // A press on one of the list's buttons is the list's own: a row opens its item, or closes
      // the sheet when it is the open one. So is one on a list that scrolls, which is its
      // scrollbar being dragged. Anywhere else in the sidebar closes it, as outside does. The
      // demo's debug drawer is where items arrive from, and is not the workspace.
      onInteractOutside={(event) => {
        const { target } = event
        if (!(target instanceof Element)) return
        const scrolling =
          target.matches("#inbox-panel .inbox-list") && target.scrollHeight > target.clientHeight
        if (scrolling || target.closest("#inbox-panel button, .debug-drawer"))
          event.preventDefault()
      }}
    >
      <SheetBody key={item.id} item={item} />
    </Sheet>
  )
}
