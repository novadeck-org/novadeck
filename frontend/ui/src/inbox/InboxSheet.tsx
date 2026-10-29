import { inboxType, type InboxRow } from "@novadeck/core/inbox"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { Sheet } from "@novadeck/toolkit/Sheet"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { ArrowLeft, Bell, BellOff, Check, Terminal, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { ConsoleSheet } from "./ConsoleSheet"
import { nextRowButton, rowOf, sheetControls } from "./inbox-dom"
import { icons } from "./inbox-icons"
import { asks } from "./inbox-state"
import { tagOf } from "./inbox-tag"
import { useInboxContext, type Receipt } from "./InboxProvider"
import type { SheetContentProps } from "./Page"
import { Text } from "./sheet-parts"

// What the sheet sits within: the whole workspace, the sidebar with it, so the sheet starts
// over the sidebar's gutter, clear of a window's border beside it.
const workspace = (): HTMLElement | null => document.querySelector<HTMLElement>(".workspace-panels")

// What the workspace behind the sheet is, which steps back while it is read.
const behind = (): HTMLElement | null => document.querySelector<HTMLElement>(".workspace-main-pane")

// The kind of message, before any of it is read: the row's icon and tone, and one word.
const KindTag = ({ item }: { readonly item: InboxRow }): React.JSX.Element => {
  const tag = tagOf(item)
  const Icon = icons[tag.type]
  return (
    <span className="console-tag" data-tone={tag.tone}>
      <Icon size={12} strokeWidth={2} aria-hidden />
      {tag.word}
    </span>
  )
}

// What the last answer did, on the sheet it moved on to: fading back after a moment. Where
// that answer turns out not to have arrived, it says so, and the way back to it.
const ReceiptLine = ({ receipt }: { readonly receipt: Receipt }): React.JSX.Element => {
  const { state, open } = useInboxContext()
  const failed = state.failed[receipt.from]
  if (failed)
    return (
      <div className="console-receipt" data-failed="true" role="alert">
        <span>{failed}</span>
        <button
          type="button"
          className="button link inbox-link text-control"
          onClick={() => open(receipt.from)}
        >
          Back to it
        </button>
      </div>
    )
  return (
    <div className="console-receipt" role="status">
      <Check size={12} aria-hidden />
      <Text text={receipt.note} />
    </div>
  )
}

// One item's sheet: its head, then its page.
const SheetBody = ({ item }: { readonly item: InboxRow }): React.JSX.Element => {
  const { state, sent, phone, receipt, close, submit, change, reveal, snooze } = useInboxContext()
  const answered = sent[item.id]
  const failed = state.failed[item.id]
  const present = state.items.some((each) => each.id === item.id)
  const unavailable = item.kind === "ask" && failed !== undefined && !present
  // An answer that didn't take is no answer.
  const confirmed =
    failed === undefined && !state.answering[item.id] && !present ? answered : undefined
  const content: SheetContentProps = {
    item,
    sent: confirmed,
    answering: Boolean(state.answering[item.id]) || unavailable,
    failed,
    submit: (answer, note) => submit(item, answer, note),
    change: (answer) => change(item, answer),
    reveal: () => reveal(item),
  }
  const { source } = item
  const leave = phone ? "Back to the Inbox" : "Close"
  return (
    <div
      className="inbox-sheet console"
      data-type={inboxType(item)}
      data-tone={tagOf(item).tone}
      data-state={item.settled ? "settled" : confirmed ? "answered" : "asking"}
      // Tab leaves the sheet the way it came: back to its row from the first control, and on
      // to the row after it from the last, so keyboard focus never falls out to the workspace.
      onKeyDown={(event) => {
        if (event.key !== "Tab" || phone) return
        const page = sheetControls(event.currentTarget)
        const head = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(".inbox-sheet-head button"),
        )
        // Tab order inside the sheet is the head, then its page.
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
      <header className="inbox-sheet-head console-head">
        <KindTag item={item} />
        <span className="console-crumb">
          <span className="console-project">{source.projectName}</span>
          <span className="console-sep" aria-hidden="true">
            /
          </span>
          <h2 className="inbox-sheet-title" tabIndex={-1}>
            {source.title}
          </h2>
        </span>
        <HandleChip handle={source.handle} />
        <span className="console-grow" />
        {snooze && asks(item) ? (
          <Tooltip content={item.snoozed ? "Unsnooze · S" : "Snooze · S"}>
            <button
              type="button"
              className="icon-button dim size-7"
              aria-label={item.snoozed ? "Unsnooze" : "Snooze"}
              onClick={() => snooze(item, !item.snoozed)}
            >
              {item.snoozed ? (
                <Bell size={14} strokeWidth={1.6} />
              ) : (
                <BellOff size={14} strokeWidth={1.6} />
              )}
            </button>
          </Tooltip>
        ) : null}
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
      {receipt && receipt.from !== item.id && <ReceiptLine receipt={receipt} />}
      <ConsoleSheet {...content} />
    </div>
  )
}

// The open item's sheet: beside its row over the workspace, or on a screen of its own.
// `active` is whether the Inbox is the panel the sidebar shows.
export const InboxSheet = ({ active }: { readonly active: boolean }): React.JSX.Element | null => {
  const { view, current, phone, close, shown } = useInboxContext()
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
    behind()?.setAttribute("data-inbox-reading", String(open && !phone))
  }, [open, phone])
  useEffect(() => () => behind()?.removeAttribute("data-inbox-reading"), [])
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
      placeKey={String(shown.findIndex(({ id }) => id === item.id))}
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
