import { inboxType, type InboxRow, type InboxState } from "@novadeck/core/inbox"
import { NovaMark } from "@novadeck/toolkit/NovaLogo"
import { sidebarListClasses } from "@novadeck/toolkit/SidebarItem"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { CheckCheck, CircleCheck, ListX, LoaderCircle, X } from "lucide-react"

import { focusSheet, focusSheetSoon, nextRowButton } from "./inbox-dom"
import { icons, typeWords } from "./inbox-icons"
import { hasSettled, hasUpdates, needing, needs, settledStart, updatesStart } from "./inbox-state"
import { readLabel, resumesLabel, subjectOf, toneOf, waitLabel } from "./inbox-text"
import { started, useInboxContext } from "./InboxProvider"
import { Text } from "./sheet-parts"

// Whether the person answered the item, here, and it has since gone: it keeps its place in
// the list, answered, until the sheet closes.
const answeredIn = (
  item: InboxRow,
  state: Pick<InboxState, "answering" | "failed">,
  ghosts: Readonly<Record<string, InboxRow>>,
): boolean => item.id in ghosts && !state.answering[item.id] && !state.failed[item.id]

// One row, for triage only: the type's icon tinted by how urgent it is, the subject, how
// long the agent has waited if it stopped, and under it the project and what is extra. A row
// that asks something stays bright until it is answered, opened or not. `first` marks the row
// after the last that asks, where the updates' line goes; `settledFirst` the first of the settled
// asks that end the list, where theirs goes. A settled ask (dismissed, withdrawn or answered in
// its terminal) stays, struck through, and opens nothing; an open Novadeck ask can be dismissed.
const Row = ({
  item,
  asks,
  first,
  settledFirst,
}: {
  readonly item: InboxRow
  readonly asks: boolean
  readonly first: boolean
  readonly settledFirst: boolean
}): React.JSX.Element => {
  const { state, view, now, drafts, ghosts, open, dismiss } = useInboxContext()
  const { settled } = item
  const type = inboxType(item)
  const pending = Boolean(state.answering[item.id])
  const answered = answeredIn(item, state, ghosts)
  const answering = pending || answered
  const Icon = pending ? LoaderCircle : answered ? CircleCheck : icons[type]
  const current = view.open === item.id
  const dismissable = dismiss !== undefined && item.kind === "ask" && !settled && !pending
  const subject = subjectOf(item).replaceAll("`", "")
  const extras = settled
    ? [settledWords[settled.how]]
    : [
        item.kind !== "feedback" && started(drafts[item.id]) && !answering ? "Draft" : null,
        answering ? null : resumesLabel(item),
        readLabel(item),
      ].filter((extra): extra is string => extra !== null)
  return (
    <div
      role="listitem"
      className="item inbox-row"
      data-inbox-row={item.id}
      data-type={type}
      data-urgency={settled ? "quiet" : answered ? "answered" : toneOf(item)}
      data-seen={item.seen}
      data-needs={asks}
      data-updates-start={first}
      data-settled-start={settledFirst}
      data-settled={settled?.how}
      data-dismissable={dismissable}
      data-arrived={view.arrived.includes(item.id)}
      data-selected={current}
    >
      <button
        type="button"
        className="inbox-row-select"
        aria-label={`${typeWords[type]}: ${subject}, ${item.source.projectName}`}
        aria-current={current ? "true" : undefined}
        aria-disabled={settled ? "true" : undefined}
        onClick={(event) => {
          if (settled) return
          open(item.id)
          // From the keyboard, on to the sheet that opens.
          if (event.detail === 0) focusSheetSoon()
        }}
        // The sheet follows its row in the tab order: Tab or the right arrow goes into it.
        onKeyDown={(event) => {
          // Delete dismisses an ask that can be, and the keyboard goes on to the next row.
          if (
            dismissable &&
            (event.key === "Delete" || event.key === "Backspace") &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            event.preventDefault()
            const next = nextRowButton(item.id)
            dismiss(item.id)
            next?.focus()
            return
          }
          if (!current || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
          if ((event.key === "Tab" || event.key === "ArrowRight") && focusSheet())
            event.preventDefault()
        }}
      >
        <span className="inbox-row-icon" aria-hidden="true">
          <Icon size={14} strokeWidth={1.6} />
        </span>
        <span className="inbox-row-subject text-body">
          <Text text={subjectOf(item)} />
        </span>
        <span className="inbox-row-wait text-caption">
          {settled
            ? waitLabel(settled.at, now)
            : item.stopped && !answering
              ? waitLabel(item.at, now)
              : ""}
        </span>
        <span className="inbox-row-meta text-caption">
          <span className="inbox-row-project" title={item.source.projectName}>
            {item.source.projectName}
          </span>
          {extras.map((extra) => (
            <span
              className="inbox-row-extra"
              data-extra={extra === "Draft" ? "draft" : undefined}
              key={extra}
            >
              · {extra}
            </span>
          ))}
        </span>
      </button>
      {dismissable ? (
        <Tooltip content="Dismiss · Delete">
          <button
            type="button"
            className="inbox-row-dismiss icon-button dim size-7"
            aria-label={`Dismiss: ${subject}`}
            onClick={(event) => {
              // The keyboard was on this button, which goes with the click: it stays on the row.
              const keyboard = event.detail === 0
              const select = event.currentTarget.previousElementSibling
              dismiss(item.id)
              if (keyboard && select instanceof HTMLElement) select.focus()
            }}
          >
            <X size={14} strokeWidth={1.6} />
          </button>
        </Tooltip>
      ) : null}
    </div>
  )
}

const settledWords = {
  dismissed: "Dismissed",
  withdrawn: "Withdrawn",
  replied: "Replied in terminal",
} as const

// Beside the title: how many wait on the person, as the rail's bell says, while any do. It reads
// the Inbox itself, so a change in what waits re-renders it and not the sidebar.
export const InboxCount = (): string | null => {
  const { state } = useInboxContext()
  const waiting = needing(state.items).length
  return waiting === 0 ? null : `${waiting} waiting`
}

// The pill beside the title while items wait to join the list.
export const HeldPill = (): React.JSX.Element | null => {
  const { held, showHeld } = useInboxContext()
  if (held.length === 0) return null
  return (
    <button type="button" className="inbox-held text-caption" onClick={showHeld}>
      {held.length} new · show
    </button>
  )
}

// Beside the close button: reads every update, and leaves what waits on the person.
export const InboxMarkAll = (): React.JSX.Element | null => {
  const { state, readAll } = useInboxContext()
  if (!hasUpdates(state.items)) return null
  return (
    <Tooltip content="Mark all read">
      <button
        className="icon-button dim quiet size-7"
        type="button"
        aria-label="Mark all read"
        onClick={readAll}
      >
        <CheckCheck size={14} strokeWidth={1.6} />
      </button>
    </Tooltip>
  )
}

// Beside Mark all read while any ask has settled: removes the settled asks from the list.
export const InboxClear = (): React.JSX.Element | null => {
  const { state, clear } = useInboxContext()
  if (!clear || !hasSettled(state.items)) return null
  return (
    <Tooltip content="Clear settled">
      <button
        className="icon-button dim quiet size-7"
        type="button"
        aria-label="Clear settled"
        onClick={clear}
      >
        <ListX size={14} strokeWidth={1.6} />
      </button>
    </Tooltip>
  )
}

// Everything across the workspace that asks for the person, one row each.
export const InboxList = (): React.JSX.Element => {
  const { shown, view, working, state, ghosts } = useInboxContext()
  const rows = shown.map((item) => ({
    item,
    asks: needs(item) && !answeredIn(item, state, ghosts),
  }))
  const settledAt = settledStart(shown.map((item) => item.settled !== undefined))
  const updates = updatesStart(
    rows.slice(0, settledAt < 0 ? rows.length : settledAt).map(({ asks }) => asks),
  )
  return (
    <div
      className="inbox-panel flex min-h-0 min-w-0 w-full flex-1 flex-col"
      data-sheet={view.open !== null ? "open" : "closed"}
    >
      {shown.length === 0 ? (
        <div className="inbox-empty">
          <NovaMark size={28} />
          <h3 className="text-body">Nothing needs you</h3>
          <p className="text-control">
            {working
              ? "Your agents are working. When one needs you, it shows up here."
              : "When an agent needs you, it shows up here."}
          </p>
        </div>
      ) : (
        <div
          className={`inbox-list ${sidebarListClasses}`}
          role="list"
          aria-label="Messages from your agents"
        >
          {rows.map(({ item, asks }, index) => (
            <Row
              key={item.id}
              item={item}
              asks={asks}
              first={index === updates}
              settledFirst={index === settledAt}
            />
          ))}
        </div>
      )}
    </div>
  )
}
