import { inboxType, type InboxItem } from "@novadeck/core/inbox"
import { CheckCheck, CircleCheck, LoaderCircle } from "lucide-react"

import { sidebarListClasses } from "../sidebar/SidebarItem"
import { NovaMark } from "../ui-toolkit/NovaLogo"
import { Tooltip } from "../ui-toolkit/Tooltip"
import { focusSheet, focusSheetSoon } from "./inbox-dom"
import { icons, typeWords } from "./inbox-icons"
import { hasUpdates } from "./inbox-state"
import { readLabel, resumesLabel, subjectOf, toneOf, waitLabel } from "./inbox-text"
import { started, useInboxContext } from "./InboxProvider"
import { Text } from "./sheet-parts"

// One row, for triage only: the type's icon tinted by how urgent it is, the subject, how
// long the agent has waited if it stopped, and under it the project and what is extra.
const Row = ({ item }: { readonly item: InboxItem }): React.JSX.Element => {
  const { state, view, now, drafts, ghosts, open } = useInboxContext()
  const type = inboxType(item)
  const pending = Boolean(state.answering[item.id])
  const answered = item.id in ghosts && !pending && !state.failed[item.id]
  const answering = pending || answered
  const Icon = pending ? LoaderCircle : answered ? CircleCheck : icons[type]
  const current = view.open === item.id
  const extras = [
    started(drafts[item.id]) && !answering ? "Draft" : null,
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
  const { shown, view } = useInboxContext()
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
            Your agents are working. When one needs you, it shows up here.
          </p>
        </div>
      ) : (
        <div
          className={`inbox-list ${sidebarListClasses}`}
          role="list"
          aria-label="Messages from your agents"
        >
          {shown.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}
