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

// Whether the person answered the row, here, and it has since gone: it keeps its place in
// the list, answered, until the sheet closes.
const answeredIn = (
  row: InboxRow,
  state: Pick<InboxState, "answering" | "failed">,
  ghosts: Readonly<Record<string, InboxRow>>,
): boolean => row.id in ghosts && !state.answering[row.id] && !state.failed[row.id]

// One row, for triage only: the type's icon tinted by how urgent it is, the subject, how
// long the agent has waited if it stopped, and under it the project and what is extra. A row
// that asks something stays bright until it is answered, opened or not. `first` marks the row
// after the last that asks, where the updates' line goes; `settledFirst` the first of the settled
// asks that end the list, where theirs goes. A settled ask (dismissed, withdrawn or answered in
// its terminal) stays, struck through, and opens nothing; an open Novadeck ask can be dismissed.
const Row = ({
  row,
  asks,
  first,
  settledFirst,
}: {
  readonly row: InboxRow
  readonly asks: boolean
  readonly first: boolean
  readonly settledFirst: boolean
}): React.JSX.Element => {
  const { state, view, now, drafts, ghosts, open, close, dismiss } = useInboxContext()
  const { settled } = row
  const type = inboxType(row)
  const pending = Boolean(state.answering[row.id])
  const answered = answeredIn(row, state, ghosts)
  const answering = pending || answered
  const Icon = pending ? LoaderCircle : answered ? CircleCheck : icons[type]
  const current = view.open === row.id
  const dismissable =
    dismiss !== undefined && row.kind === "ask" && !settled && !pending && !answered
  const subject = subjectOf(row).replaceAll("`", "")
  const extras = settled
    ? [settledWords[settled.how]]
    : [
        started(drafts[row.id]) && !answering ? "Draft" : null,
        answering ? null : resumesLabel(row),
        readLabel(row),
      ].filter((extra): extra is string => extra !== null)
  return (
    <div
      role="listitem"
      className="item inbox-row"
      data-inbox-row={row.id}
      data-type={type}
      data-urgency={settled ? "quiet" : answered ? "answered" : toneOf(row)}
      data-seen={row.seen}
      data-needs={asks}
      data-updates-start={first}
      data-settled-start={settledFirst}
      data-settled={settled?.how}
      data-dismissable={dismissable}
      data-arrived={view.arrived.includes(row.id)}
      data-selected={current}
    >
      <button
        type="button"
        className="inbox-row-select"
        aria-label={`${typeWords[type]}: ${subject}, ${row.source.projectName}${
          settled ? `, ${settledWords[settled.how].toLowerCase()}` : ""
        }`}
        aria-current={current ? "true" : undefined}
        aria-disabled={settled ? "true" : undefined}
        onClick={(event) => {
          if (settled) return
          // Pressed again, the open row closes its sheet.
          if (current) return close()
          open(row.id)
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
            const next = nextRowButton(row.id)
            dismiss(row.id)
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
          <Text text={subjectOf(row)} />
        </span>
        <span className="inbox-row-wait text-caption">
          {settled
            ? waitLabel(settled.at, now)
            : row.stopped && !answering
              ? waitLabel(row.at, now)
              : ""}
        </span>
        <span className="inbox-row-meta text-caption">
          <span className="inbox-row-project" title={row.source.projectName}>
            {row.source.projectName}
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
              dismiss(row.id)
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

// The pill beside the title while rows wait to join the list.
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

const needsBefore = (before: InboxRow | undefined): boolean => before !== undefined && needs(before)

// Everything across the workspace that asks for the person, one row each.
export const InboxList = (): React.JSX.Element => {
  const { shown, view, working, state, ghosts } = useInboxContext()
  const placements = shown.map((row) => ({
    row,
    asks: needs(row) && !answeredIn(row, state, ghosts),
    // A row that settled in place among the asks keeps its place with them.
    placed: row.settled !== undefined && needsBefore(view.base[row.id]),
  }))
  const settledAt = settledStart(shown.map((row) => row.settled !== undefined))
  const updates = updatesStart(
    placements
      .slice(0, settledAt < 0 ? placements.length : settledAt)
      .map(({ asks, placed }) => asks || placed),
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
          {placements.map(({ row, asks }, index) => (
            <Row
              key={row.id}
              row={row}
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
