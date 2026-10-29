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
import { CheckCheck, CircleCheck, ListX, LoaderCircle, X } from "lucide-react"
import { useMemo, useState } from "react"

import { focusSheet, focusSheetSoon, nextRowButton, rowOf } from "./inbox-dom"
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
// A row that asks drags among the others that do, into the person's order (`drag`).
const Row = ({
  item,
  asks,
  first,
  settledFirst,
  drag,
}: {
  readonly item: InboxRow
  readonly asks: boolean
  readonly first: boolean
  readonly settledFirst: boolean
  readonly drag?: Drag | undefined
}): React.JSX.Element =>
  drag ? (
    <DraggedRow item={item} asks={asks} first={first} settledFirst={settledFirst} drag={drag} />
  ) : (
    <RowBody item={item} asks={asks} first={first} settledFirst={settledFirst} />
  )

const DraggedRow = ({
  drag,
  ...row
}: {
  readonly item: InboxRow
  readonly asks: boolean
  readonly first: boolean
  readonly settledFirst: boolean
  readonly drag: Drag
}): React.JSX.Element => {
  // The row's button is what drags: dnd-kit starts no drag from a button that isn't its handle.
  const { ref, handleRef, isDragSource } = useSortable({
    id: row.item.id,
    index: drag.index,
    transition: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  })
  return (
    <RowBody
      {...row}
      rowRef={ref}
      handleRef={handleRef}
      dragging={isDragSource}
      onStep={drag.onStep}
    />
  )
}

const RowBody = ({
  item,
  asks,
  first,
  settledFirst,
  rowRef,
  handleRef,
  dragging = false,
  onStep,
}: {
  readonly item: InboxRow
  readonly asks: boolean
  readonly first: boolean
  readonly settledFirst: boolean
  readonly rowRef?: (element: Element | null) => void
  readonly handleRef?: (element: Element | null) => void
  readonly dragging?: boolean
  readonly onStep?: ((by: -1 | 1) => void) | undefined
}): React.JSX.Element => {
  const { state, view, now, drafts, ghosts, open, close, dismiss } = useInboxContext()
  const { settled } = item
  const type = inboxType(item)
  const pending = Boolean(state.answering[item.id])
  const answered = answeredIn(item, state, ghosts)
  const answering = pending || answered
  const Icon = pending ? LoaderCircle : answered ? CircleCheck : icons[type]
  const current = view.open === item.id
  const dismissable =
    dismiss !== undefined && item.kind === "ask" && !settled && !pending && !answered
  const subject = subjectOf(item).replaceAll("`", "")
  const extras = settled
    ? [settledWords[settled.how]]
    : [
        started(drafts[item.id]) && !answering ? "Draft" : null,
        answering ? null : resumesLabel(item),
        readLabel(item),
      ].filter((extra): extra is string => extra !== null)
  return (
    <div
      ref={rowRef}
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
      data-dragging={dragging || undefined}
    >
      <button
        ref={handleRef}
        type="button"
        className="inbox-row-select"
        aria-keyshortcuts={onStep ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        aria-label={`${typeWords[type]}: ${subject}, ${item.source.projectName}${
          settled ? `, ${settledWords[settled.how].toLowerCase()}` : ""
        }`}
        aria-current={current ? "true" : undefined}
        aria-disabled={settled ? "true" : undefined}
        onClick={(event) => {
          if (settled) return
          // Pressed again, the open row closes its sheet.
          if (current) return close()
          open(item.id)
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
const needsBefore = (before: InboxRow | undefined): boolean => before !== undefined && needs(before)

export const InboxList = (): React.JSX.Element => {
  const { shown, view, working, state, ghosts, arrange } = useInboxContext()
  const rows = shown.map((item) => ({
    item,
    asks: needs(item) && !answeredIn(item, state, ghosts),
    // A row that settled in place among the asks keeps its place with them.
    placed: item.settled !== undefined && needsBefore(view.base[item.id]),
  }))
  // The rows that drag: those that ask, until the person answers them, where the backend
  // keeps an order.
  const dragged = arrange
    ? rows.filter(({ item, asks }) => asks && !state.answering[item.id]).map(({ item }) => item.id)
    : []
  const move = (id: string, to: number): void => {
    const from = dragged.indexOf(id)
    const at = Math.max(0, Math.min(dragged.length - 1, to))
    if (!arrange || from < 0 || from === at) return
    const order = dragged.toSpliced(from, 1).toSpliced(at, 0, id)
    // The rows that ask and are still there, one answered meanwhile among them, and one that
    // settled in place, which keeps it.
    const live = new Set(state.items.map((item) => item.id))
    const kept = new Set(
      rows
        .filter(({ item, placed }) => live.has(item.id) && (needs(item) || placed))
        .map(({ item }) => item.id),
    )
    arrange(
      arrangedIds(
        shown.map((item) => item.id),
        kept,
        dragged,
        order,
      ),
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
  const settledAt = settledStart(shown.map((item) => item.settled !== undefined))
  const updates = updatesStart(
    rows
      .slice(0, settledAt < 0 ? rows.length : settledAt)
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
            {rows.map(({ item, asks }, index) => {
              const place = dragged.indexOf(item.id)
              return (
                <Row
                  key={item.id}
                  item={item}
                  asks={asks}
                  first={index === updates}
                  settledFirst={index === settledAt}
                  drag={
                    place < 0
                      ? undefined
                      : {
                          index: place,
                          onStep: (by) => {
                            move(item.id, place + by)
                            focusRow(item.id)
                          },
                        }
                  }
                />
              )
            })}
          </DragDropProvider>
        </div>
      )}
    </div>
  )
}
