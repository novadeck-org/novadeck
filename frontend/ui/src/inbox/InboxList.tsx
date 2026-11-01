import {
  Accessibility,
  Cursor,
  Feedback,
  PointerActivationConstraints,
  PointerSensor,
} from "@dnd-kit/dom"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { DragDropProvider } from "@dnd-kit/react"
import { isSortable, useSortable } from "@dnd-kit/react/sortable"
import { inboxType, type InboxRow, type InboxState } from "@novadeck/core/inbox"
import { NovaMark } from "@novadeck/toolkit/NovaLogo"
import { sidebarListClasses } from "@novadeck/toolkit/SidebarItem"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { Bell, BellOff, CheckCheck, CircleCheck, ListX, LoaderCircle, X } from "lucide-react"
import { useMemo, useState } from "react"

import { AutoRunSection } from "./AutoRunSection"
import { GrantsSection } from "./GrantsSection"
import { focusSheet, focusSheetSoon, nextRowButton, rowOf } from "./inbox-dom"
import { icons, typeWords } from "./inbox-icons"
import {
  asks as asking,
  hasSettled,
  hasUpdates,
  needing,
  settledStart,
  updatesStart,
} from "./inbox-state"
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

// A row follows the pointer once it has moved a few pixels, so a click still opens it; the
// keyboard moves rows with Alt and the arrows instead, so dnd-kit adds no keyboard sensor and
// none of its screen reader markup.
const sensors = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 6 })],
  }),
]
const feedback = Feedback.configure({
  dropAnimation: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
})
const cursor = Cursor.configure({ cursor: "grabbing" })

// How a row the person can drag takes part: its place among the rows that drag, and Alt with
// the arrows moving it one place.
type Drag = { readonly index: number; readonly onStep: (by: -1 | 1) => void }

// One row, for triage only: the type's icon tinted by how urgent it is, the subject, how
// long the agent has waited if it stopped, and under it the project and what is extra. A row
// that asks something stays bright until it is answered, opened or not. `first` marks the row
// after the last that asks, where the updates' line goes; `settledFirst` the first of the settled
// asks that end the list, where theirs goes. A settled ask (dismissed, withdrawn or answered in
// its terminal) stays, struck through, and opens nothing; an open Novadeck ask can be dismissed.
// A row that asks drags among the others that do, into the person's order (`drag`), and can
// be snoozed (S): it keeps its place, marked, its bell-off where its wait shows.
const Row = ({
  row,
  place,
  asks,
  first,
  settledFirst,
  drag,
}: {
  readonly row: InboxRow
  // Its place in the list, which keeps a row that doesn't drag where it is.
  readonly place: number
  readonly asks: boolean
  readonly first: boolean
  readonly settledFirst: boolean
  readonly drag?: Drag | undefined
}): React.JSX.Element => {
  // One component whether it drags or not, so a row that starts or stops dragging (an answer
  // sent, an ask settled) keeps its element and the focus on it. The row's button is what
  // drags: dnd-kit starts no drag from a button that isn't its handle. A row that doesn't
  // drag is in a group of its own, which a drag never sorts.
  const {
    ref: rowRef,
    handleRef,
    isDragSource: dragging,
  } = useSortable({
    id: row.id,
    index: drag ? drag.index : place,
    group: drag ? "asks" : "still",
    disabled: !drag,
    transition: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  })
  const onStep = drag?.onStep
  const { state, view, now, drafts, ghosts, open, close, dismiss, snooze } = useInboxContext()
  const { settled } = row
  const type = inboxType(row)
  const pending = Boolean(state.answering[row.id])
  const answered = answeredIn(row, state, ghosts)
  const answering = pending || answered
  const Icon = pending ? LoaderCircle : answered ? CircleCheck : icons[type]
  const current = view.open === row.id
  const dismissable =
    dismiss !== undefined &&
    (row.kind === "ask" || row.kind === "grant") &&
    !settled &&
    !pending &&
    !answered
  const snoozable = snooze !== undefined && asking(row) && !answering
  const snoozed = Boolean(row.snoozed) && !answering
  const subject = subjectOf(row).replaceAll("`", "")
  const toggleSnooze = (): void => snooze?.(row, !row.snoozed)
  const extras = settled
    ? [settledWords[settled.how]]
    : [
        snoozed ? "Snoozed" : null,
        started(drafts[row.id]) && !answering ? "Draft" : null,
        answering ? null : resumesLabel(row),
        readLabel(row),
      ].filter((extra): extra is string => extra !== null)
  return (
    <div
      ref={rowRef}
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
      data-snoozable={snoozable}
      data-snoozed={snoozed || undefined}
      data-arrived={view.arrived.includes(row.id)}
      data-selected={current}
      data-dragging={dragging || undefined}
    >
      <button
        ref={handleRef}
        type="button"
        className="inbox-row-select"
        aria-keyshortcuts={
          [onStep && "Alt+ArrowUp Alt+ArrowDown", snoozable && "S"].filter(Boolean).join(" ") ||
          undefined
        }
        aria-label={`${typeWords[type]}: ${subject}, ${row.source.projectName}${
          settled ? `, ${settledWords[settled.how].toLowerCase()}` : snoozed ? ", snoozed" : ""
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
          // Alt and the arrows move a row that drags one place among the others.
          if (
            onStep &&
            event.altKey &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            (event.key === "ArrowUp" || event.key === "ArrowDown")
          ) {
            event.preventDefault()
            onStep(event.key === "ArrowUp" ? -1 : 1)
            return
          }
          // S snoozes the row, or brings it back.
          if (
            snoozable &&
            (event.key === "s" || event.key === "S") &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            event.preventDefault()
            toggleSnooze()
            return
          }
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
          {settled ? (
            waitLabel(settled.at, now)
          ) : snoozed ? (
            <BellOff size={14} strokeWidth={1.6} aria-hidden="true" />
          ) : row.stopped && !answering ? (
            waitLabel(row.at, now)
          ) : (
            ""
          )}
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
      {snoozable ? (
        <Tooltip content={row.snoozed ? "Unsnooze · S" : "Snooze · S"}>
          <button
            type="button"
            className="inbox-row-snooze icon-button dim size-7"
            aria-label={`${row.snoozed ? "Unsnooze" : "Snooze"}: ${subject}`}
            onClick={(event) => {
              // The keyboard was on this button, which goes with the click: it stays on the row.
              const keyboard = event.detail === 0
              const select = event.currentTarget
                .closest("[data-inbox-row]")
                ?.querySelector<HTMLElement>(".inbox-row-select")
              toggleSnooze()
              if (keyboard) select?.focus()
            }}
          >
            {row.snoozed ? (
              <Bell size={14} strokeWidth={1.6} />
            ) : (
              <BellOff size={14} strokeWidth={1.6} />
            )}
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

// The keyboard goes back to a row once it is in its new place.
const focusRow = (id: string): void => {
  requestAnimationFrame(() => rowOf(id)?.querySelector<HTMLElement>(".inbox-row-select")?.focus())
}

// The ids the person's order keeps, in the list's (`shown`) with the rows that drag,
// `dragged`, moved into `to` (theirs, in its new order): those of `kept`, the rows that ask
// and are still there.
export const arrangedIds = (
  shown: readonly string[],
  kept: ReadonlySet<string>,
  dragged: readonly string[],
  to: readonly string[],
): string[] => {
  const moved = new Set(dragged)
  let next = 0
  return shown.map((id) => (moved.has(id) ? to[next++]! : id)).filter((id) => kept.has(id))
}

// Everything across the workspace that asks for the person, one row each.
const needsBefore = (before: InboxRow | undefined): boolean =>
  before !== undefined && asking(before)

export const InboxList = (): React.JSX.Element => {
  const { shown, view, working, state, ghosts, arrange } = useInboxContext()
  const placements = shown.map((row) => ({
    row,
    asks: asking(row) && !answeredIn(row, state, ghosts),
    // A row that settled in place among the asks keeps its place with them.
    placed: row.settled !== undefined && needsBefore(view.base[row.id]),
  }))
  // The rows that drag: those that ask, until the person answers them, where the backend
  // keeps an order.
  const dragged = arrange
    ? placements
        .filter(({ row, asks }) => asks && !state.answering[row.id])
        .map(({ row }) => row.id)
    : []
  const move = (id: string, to: number): void => {
    const from = dragged.indexOf(id)
    const at = Math.max(0, Math.min(dragged.length - 1, to))
    if (!arrange || from < 0 || from === at) return
    const order = dragged.toSpliced(from, 1).toSpliced(at, 0, id)
    const moving = shown.find((row) => row.id === id)
    setMoved(
      `${moving ? `${subjectOf(moving).replaceAll("`", "")}: m` : "M"}oved to ${at + 1} of ${dragged.length}`,
    )
    // The rows that ask and are still there, one answered meanwhile among them, and one that
    // settled in place, which keeps it.
    const live = new Set(state.items.map((row) => row.id))
    const kept = new Set(
      placements
        .filter(({ row, placed }) => live.has(row.id) && (asking(row) || placed))
        .map(({ row }) => row.id),
    )
    const byId = new Map(shown.map((row) => [row.id, row]))
    arrange(
      arrangedIds(
        shown.map((row) => row.id),
        kept,
        dragged,
        order,
      ).flatMap((each) => byId.get(each) ?? []),
    )
  }
  // The element that holds the rows, which a drag stays within.
  const [list, setList] = useState<HTMLDivElement | null>(null)
  const modifiers = useMemo(() => [RestrictToElement.configure({ element: list })], [list])
  // dnd-kit moves the dragged row's element among its neighbours as it goes, and puts it
  // back only in some drags: every drag's end remounts the rows, so they are rebuilt from
  // the order, which drops the focus with the dragged row, so it goes back to it
  // (`focusRow`).
  const [drags, setDrags] = useState(0)
  // Where a row went, for assistive technology, which dnd-kit's own markup would have said.
  const [moved, setMoved] = useState("")
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
      <AutoRunSection />
      <GrantsSection />
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
          ref={setList}
          className={`inbox-list ${sidebarListClasses}`}
          role="list"
          aria-label="Messages from your agents"
        >
          <DragDropProvider
            key={drags}
            sensors={sensors}
            modifiers={modifiers}
            plugins={(defaults) => [
              ...defaults.filter((plugin) => plugin !== Accessibility),
              feedback,
              cursor,
            ]}
            onDragEnd={(event) => {
              setDrags((count) => count + 1)
              const { source } = event.operation
              if (!isSortable(source)) return
              const id = String(source.id)
              if (source.element?.contains(document.activeElement)) focusRow(id)
              if (event.canceled || source.initialIndex === source.index) return
              move(id, source.index)
            }}
          >
            {placements.map(({ row, asks }, index) => {
              const place = dragged.indexOf(row.id)
              return (
                <Row
                  key={row.id}
                  row={row}
                  place={index}
                  asks={asks}
                  first={index === updates}
                  settledFirst={index === settledAt}
                  drag={
                    place < 0
                      ? undefined
                      : {
                          index: place,
                          onStep: (by) => {
                            move(row.id, place + by)
                            focusRow(row.id)
                          },
                        }
                  }
                />
              )
            })}
          </DragDropProvider>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {moved}
      </span>
    </div>
  )
}
