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
import { inboxType, entryKey, type InboxEntry, type InboxState } from "@novadeck/core/inbox"
import { NovaMark } from "@novadeck/toolkit/NovaLogo"
import {
  sidebarListClasses,
  sidebarRowClasses,
  sidebarRowIconClasses,
  sidebarRowNameClasses,
  sidebarRowSelectClasses,
} from "@novadeck/toolkit/SidebarItem"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { Bell, BellOff, LoaderCircle, X } from "lucide-react"
import { useCallback, useMemo, useState, memo, type CSSProperties } from "react"

import { focusSheet, focusSheetSoon, nextRowButton, rowOf } from "./inbox-dom"
import { iconKey, icons, tintOf, typeWords } from "./inbox-icons"
import { asks as asking, needing } from "./inbox-state"
import { endedWords, readLabel, resumesLabel, subjectOf, waitLabel } from "./inbox-text"
import { started, useInboxContext } from "./InboxProvider"
import { useSight } from "./read-on-leaving"
import { Text } from "./sheet-parts"

// Whether the person answered the entry, here, and it has since gone: it keeps its place in
// the list, answered, until the sheet closes.
const answeredIn = (
  entry: InboxEntry,
  state: Pick<InboxState, "answering" | "failed">,
  ghosts: Readonly<Record<string, InboxEntry>>,
): boolean => entry.id in ghosts && !state.answering[entry.id] && !state.failed[entry.id]

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

const actionClasses = "inbox-row-action icon-button small dim quiet"

// How a row the person can drag takes part: its place among the rows that drag, and Alt with
// the arrows moving it one place.
type Drag = { readonly index: number; readonly onStep: (by: -1 | 1) => void }

// One row, for triage only, drawn as a terminal's tab is (TerminalTab.tsx), from the sidebar
// item's parts: the kind's icon tinted by what it wants of the person, the subject on the name's
// line (whole in its tooltip), and under it a tab's detail line: the project and what is extra,
// and at its end, where a tab holds its @handle, how long the agent has waited if it stopped.
// A row that asks something stays bright until it is answered, opened or not. A resolved row stays as
// history, in gray, with how it ended on its detail line, and opens its sheet to read; an open
// Novadeck ask can be dismissed. An update whose row has been in sight for a moment is read once
// the person leaves the list (`read-on-leaving.ts`), as its subject is often all it says.
// A row that asks drags among the others that do, into the person's order (`drag`), and can
// be snoozed (S): it keeps its place, marked, its bell-off where its wait shows, and there its
// unsnooze button instead of a dismiss button. Its buttons slide in over the wait under the
// pointer or with focus, as a tab's Hide and Rename do over its handle.
const InboxRow = ({
  entry,
  place,
  asks,
  drag,
}: {
  readonly entry: InboxEntry
  // Its place in the list, which keeps a row that doesn't drag where it is.
  readonly place: number
  readonly asks: boolean
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
    id: entry.id,
    index: drag ? drag.index : place,
    group: drag ? "asks" : "still",
    disabled: !drag,
    transition: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  })
  const onStep = drag?.onStep
  const {
    state,
    view,
    now,
    drafts,
    ghosts,
    active,
    looking,
    open,
    close,
    sighted,
    dismiss,
    snooze,
  } = useInboxContext()
  const { settled } = entry
  // An update is seen once its row has been in sight for a moment, on the Inbox's panel while
  // it shows, and read when the person leaves the list. A panel on its way out stays in sight
  // to the observer until it has faded (sidebar.css), so the panel's own flag says when it shows.
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const ref = useCallback(
    (node: HTMLDivElement | null): void => {
      rowRef(node)
      setElement(node)
    },
    [rowRef],
  )
  // One whose read failed waits to be opened, as the landing lands it to be read by hand.
  const unread =
    active &&
    entry.kind === "update" &&
    !settled &&
    !state.answering[entry.id] &&
    state.failed[entry.id] === undefined
  useSight(element, unread, looking, () => sighted(entry))
  const type = inboxType(entry)
  const pending = Boolean(state.answering[entry.id])
  // Answered here and gone from the backend's entries, which keeps it until its sheet closes.
  const answered = answeredIn(entry, state, ghosts)
  const answering = pending || answered
  const Icon = pending ? LoaderCircle : icons[iconKey(entry)]
  const current = view.open === entry.id
  const snoozable = snooze !== undefined && asking(entry) && !answering
  const snoozed = Boolean(entry.snoozed) && !answering
  // A snoozed row's unsnooze button has the dismiss button's place: it is brought back before
  // it is dismissed.
  const dismissable =
    dismiss !== undefined &&
    entry.kind === "ask" &&
    !settled &&
    !pending &&
    !answered &&
    !(snoozed && snoozable)
  const subject = subjectOf(entry).replaceAll("`", "")
  const toggleSnooze = (): void => snooze?.(entry, !entry.snoozed)
  const extras = settled
    ? [endedWords[settled.how]]
    : [
        snoozed ? "Snoozed" : null,
        started(drafts[entryKey(entry)]) && !answering ? "Draft" : null,
        answering ? null : resumesLabel(entry),
        readLabel(entry),
      ].filter((extra): extra is string => extra !== null)
  // Room on the detail line for the buttons that slide in: a tab's 26px each.
  const buttons = Number(dismissable) + Number(snoozable)
  const label = `${typeWords[type]}: ${subject}, ${entry.source.projectName}${
    settled ? `, ${endedWords[settled.how].toLowerCase()}` : snoozed ? ", snoozed" : ""
  }`
  return (
    <div
      ref={ref}
      role="listitem"
      className={`${sidebarRowClasses} min-h-17 inbox-row`}
      style={
        buttons ? ({ "--_sidebar-actions-space": `${buttons * 26}px` } as CSSProperties) : undefined
      }
      data-inbox-row={entry.id}
      data-tour="inbox-card"
      data-type={type}
      data-tint={answered ? "muted" : tintOf(entry)}
      data-seen={entry.seen}
      data-needs={asks}
      data-settled={settled?.how}
      data-dismissable={dismissable}
      data-snoozable={snoozable}
      data-snoozed={snoozed || undefined}
      data-arrived={view.arrived.includes(entry.id)}
      data-selected={current}
      data-dragging={dragging || undefined}
    >
      <Tooltip content={`${subject}\n${entry.source.projectName}`} placement="right-start">
        <button
          ref={handleRef}
          type="button"
          className={`${sidebarRowSelectClasses} inbox-row-select`}
          aria-keyshortcuts={
            [onStep && "Alt+ArrowUp Alt+ArrowDown", snoozable && "S"].filter(Boolean).join(" ") ||
            undefined
          }
          aria-label={label}
          aria-current={current ? "true" : undefined}
          onClick={(event) => {
            // Pressed again, the open row closes its sheet.
            if (current) return close()
            open(entry.id)
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
              const next = nextRowButton(entry.id)
              dismiss(entry.id)
              next?.focus()
              return
            }
            if (!current || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
            if ((event.key === "Tab" || event.key === "ArrowRight") && focusSheet())
              event.preventDefault()
          }}
        >
          <span className={`${sidebarRowIconClasses} inbox-row-icon`} aria-hidden="true">
            <Icon size={14} strokeWidth={1.6} />
          </span>
          <span className="sidebar-item-copy flex min-w-0 flex-1 flex-col gap-1">
            <strong className={`${sidebarRowNameClasses()} inbox-row-subject`}>
              <Text text={subjectOf(entry)} />
            </strong>
            <span className="sidebar-item-detail item-detail inbox-row-meta flex h-6 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-caption leading-[18px]">
              {/* One glyph wide, as a tab's, so the line starts where a tab's program does. */}
              <span aria-hidden className="inbox-row-glyph inline-block w-[1ch] shrink-0" />
              {/* The project and what is extra give way together, so the wait keeps its place. */}
              <span className="inbox-row-words min-w-0 truncate">
                <span className="inbox-row-project">{entry.source.projectName}</span>
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
              <span className="inbox-row-wait shrink-0">
                {settled ? (
                  waitLabel(settled.at, now)
                ) : snoozed ? (
                  <BellOff size={12} strokeWidth={1.6} aria-hidden="true" />
                ) : entry.stopped && !answering ? (
                  waitLabel(entry.at, now)
                ) : (
                  ""
                )}
              </span>
            </span>
          </span>
        </button>
      </Tooltip>
      {buttons > 0 && (
        <div className="sidebar-item-actions absolute top-[31px] right-2 flex h-6 shrink-0 items-center">
          <div className="inbox-row-slot flex items-center">
            {snoozable ? (
              <Tooltip content={entry.snoozed ? "Unsnooze · S" : "Snooze · S"}>
                <button
                  type="button"
                  className={`${actionClasses} inbox-row-snooze`}
                  aria-label={`${entry.snoozed ? "Unsnooze" : "Snooze"}: ${subject}`}
                  onClick={(event) => {
                    // The keyboard was on this button, which goes with the click: it stays on
                    // the row.
                    const keyboard = event.detail === 0
                    const select = event.currentTarget
                      .closest("[data-inbox-row]")
                      ?.querySelector<HTMLElement>(".inbox-row-select")
                    toggleSnooze()
                    if (keyboard) select?.focus()
                  }}
                >
                  {entry.snoozed ? (
                    <Bell size={14} strokeWidth={1.5} />
                  ) : (
                    <BellOff size={14} strokeWidth={1.5} />
                  )}
                </button>
              </Tooltip>
            ) : null}
            {dismissable ? (
              <Tooltip content="Dismiss · Delete">
                <button
                  type="button"
                  className={`${actionClasses} inbox-row-dismiss`}
                  aria-label={`Dismiss: ${subject}`}
                  onClick={(event) => {
                    // The second click of a double one meant for the unsnooze button, whose
                    // place this takes as the row comes back, dismisses nothing.
                    if (event.detail > 1) return
                    // The keyboard was on this button, which goes with the click: it stays on
                    // the row.
                    const keyboard = event.detail === 0
                    const select = event.currentTarget
                      .closest("[data-inbox-row]")
                      ?.querySelector<HTMLElement>(".inbox-row-select")
                    dismiss(entry.id)
                    if (keyboard) select?.focus()
                  }}
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              </Tooltip>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

// Beside the title: how many wait on the person, as the rail's bell says, while any do. It reads
// the Inbox itself, so a change in what waits re-renders it and not the sidebar.
const InboxCountView = (): string | null => {
  const { state } = useInboxContext()
  const waiting = needing(state.items).length
  return waiting === 0 ? null : `${waiting} waiting`
}

// The pill beside the title while rows wait to join the list: short, so it fits beside the
// title and its count at the sidebar's usual width; its name says what pressing it does.
const HeldPillView = (): React.JSX.Element | null => {
  const { held, showHeld } = useInboxContext()
  if (held.length === 0) return null
  return (
    <button
      type="button"
      className="inbox-held text-caption"
      aria-label={`Show ${held.length} new`}
      onClick={showHeld}
    >
      {held.length} new
    </button>
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
const needsBefore = (before: InboxEntry | undefined): boolean =>
  before !== undefined && asking(before)

const InboxListView = (): React.JSX.Element => {
  const { shown, view, working, state, ghosts, arrange } = useInboxContext()
  const placements = shown.map((entry) => ({
    entry,
    asks: asking(entry) && !answeredIn(entry, state, ghosts),
    // A row that resolved in place among the asks keeps its place with them.
    placed: entry.settled !== undefined && needsBefore(view.base[entry.id]),
  }))
  // The rows that drag: those that ask, until the person answers them, where the backend
  // keeps an order.
  const dragged = arrange
    ? placements
        .filter(({ entry, asks }) => asks && !state.answering[entry.id])
        .map(({ entry }) => entry.id)
    : []
  const move = (id: string, to: number): void => {
    const from = dragged.indexOf(id)
    const at = Math.max(0, Math.min(dragged.length - 1, to))
    if (!arrange || from < 0 || from === at) return
    const order = dragged.toSpliced(from, 1).toSpliced(at, 0, id)
    const moving = shown.find((entry) => entry.id === id)
    setMoved(
      `${moving ? `${subjectOf(moving).replaceAll("`", "")}: m` : "M"}oved to ${at + 1} of ${dragged.length}`,
    )
    // The rows that ask and are still there, one answered meanwhile among them, and one that
    // resolved in place, which keeps it.
    const live = new Set(state.items.map((entry) => entry.id))
    const kept = new Set(
      placements
        .filter(({ entry, placed }) => live.has(entry.id) && (asking(entry) || placed))
        .map(({ entry }) => entry.id),
    )
    const byId = new Map(shown.map((entry) => [entry.id, entry]))
    arrange(
      arrangedIds(
        shown.map((entry) => entry.id),
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
            {placements.map(({ entry, asks }, index) => {
              const place = dragged.indexOf(entry.id)
              return (
                <InboxRow
                  key={entry.id}
                  entry={entry}
                  place={index}
                  asks={asks}
                  drag={
                    place < 0
                      ? undefined
                      : {
                          index: place,
                          onStep: (by) => {
                            move(entry.id, place + by)
                            focusRow(entry.id)
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

// Each reads the Inbox itself and takes no props, so the sidebar drawing again draws none of them.
export const InboxCount = memo(InboxCountView)
export const HeldPill = memo(HeldPillView)
export const InboxList = memo(InboxListView)
