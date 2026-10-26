import { inboxType, type InboxItem, type InboxState } from "@novadeck/core/inbox"
import { NovaMark } from "@novadeck/toolkit/NovaLogo"
import { sidebarListClasses } from "@novadeck/toolkit/SidebarItem"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { CheckCheck, CircleCheck, LoaderCircle } from "lucide-react"

import { focusSheet, focusSheetSoon } from "./inbox-dom"
import { icons, typeWords } from "./inbox-icons"
import { hasUpdates, needing, needs, updatesStart } from "./inbox-state"
import { readLabel, resumesLabel, subjectOf, toneOf, waitLabel } from "./inbox-text"
import { started, useInboxContext } from "./InboxProvider"
import { Text } from "./sheet-parts"

// Whether the person answered the item, here, and it has since gone: it keeps its place in
// the list, answered, until the sheet closes.
const answeredIn = (
  item: InboxItem,
  state: Pick<InboxState, "answering" | "failed">,
  ghosts: Readonly<Record<string, InboxItem>>,
): boolean => item.id in ghosts && !state.answering[item.id] && !state.failed[item.id]

// One row, for triage only: the type's icon tinted by how urgent it is, the subject, how
// long the agent has waited if it stopped, and under it the project and what is extra. A row
// that asks something stays bright until it is answered, opened or not. `first` marks the row after the last that asks, where the updates' line goes.
const Row = ({
  item,
  asks,
  first,
}: {
  readonly item: InboxItem
  readonly asks: boolean
  readonly first: boolean
}): React.JSX.Element => {
  const { state, view, now, drafts, ghosts, open } = useInboxContext()
  const type = inboxType(item)
  const pending = Boolean(state.answering[item.id])
  const answered = answeredIn(item, state, ghosts)
  const answering = pending || answered
  const Icon = pending ? LoaderCircle : answered ? CircleCheck : icons[type]
  const current = view.open === item.id
  const extras = [
    item.kind !== "feedback" && started(drafts[item.id]) && !answering ? "Draft" : null,
    answering ? null : resumesLabel(item),
    readLabel(item),
  ].filter((extra): extra is string => extra !== null)
  return (
    <div
      role="listitem"
      className="item inbox-row"
      data-inbox-item={item.id}
      data-type={type}
      data-urgency={answered ? "answered" : toneOf(item)}
      data-seen={item.seen}
      data-needs={asks}
      data-updates-start={first}
      data-arrived={view.arrived.includes(item.id)}
      data-selected={current}
    >
      <button
        type="button"
        className="inbox-row-select"
        aria-label={`${typeWords[type]}: ${subjectOf(item).replaceAll("`", "")}, ${item.source.projectName}`}
        aria-current={current ? "true" : undefined}
        onClick={(event) => {
          open(item.id)
          // From the keyboard, on to the sheet that opens.
          if (event.detail === 0) focusSheetSoon()
        }}
        // The sheet follows its row in the tab order: Tab or the right arrow goes into it.
        onKeyDown={(event) => {
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
          {item.stopped && !answering ? waitLabel(item.at, now) : ""}
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
    </div>
  )
}

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

// Everything across the workspace that asks for the person, one row each.
export const InboxList = (): React.JSX.Element => {
  const { shown, view, working, state, ghosts } = useInboxContext()
  const rows = shown.map((item) => ({
    item,
    asks: needs(item) && !answeredIn(item, state, ghosts),
  }))
  const updates = updatesStart(rows.map(({ asks }) => asks))
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
            <Row key={item.id} item={item} asks={asks} first={index === updates} />
          ))}
        </div>
      )}
    </div>
  )
}
