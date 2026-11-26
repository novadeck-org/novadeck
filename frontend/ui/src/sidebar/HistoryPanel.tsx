import type { AgentName } from "@novadeck/core/harnesses"
import type { ClosedTerminal } from "@novadeck/core/history"
import type { AgentConnection } from "@novadeck/core/port"
import { ContextMenu, type ContextMenuAction } from "@novadeck/toolkit/ContextMenu"
import { SidebarItem, sidebarListClasses } from "@novadeck/toolkit/SidebarItem"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { ArrowRight, Plug, RotateCcw, Search } from "lucide-react"
import { Fragment, useCallback, useEffect, useState, type ReactNode, memo } from "react"

import {
  agentName,
  closedFull,
  litPieces,
  rowMatches,
  rowFolder,
  rowTooltip,
  rowView,
  summaryExcerpt,
  type RowView,
} from "./history-rows"
import { panelLabels } from "./panel-labels"
import { SidebarPanel } from "./SidebarPanel"

// A row's accessible name, as a tab's: what selecting it selects, and how it stands where it
// can't be restored.
const labelOf = (row: ClosedTerminal, view: RowView): string => {
  switch (view.state) {
    case "ready":
      return `Select ${row.title}`
    case "open":
      return `Select ${row.title}, open as ${view.end.text}`
    case "restoring":
      return `Select ${row.title}, restoring`
    case "gone":
      return `Select ${row.title}, unavailable`
    case "disconnected":
      return `Select ${row.title}, not connected`
  }
}

const Lit = ({ text, typed }: { text: string; typed: string }): React.JSX.Element => (
  <>
    {litPieces(text, typed).map((piece) =>
      piece.lit ? (
        <mark key={piece.at}>{piece.text}</mark>
      ) : (
        <Fragment key={piece.at}>{piece.text}</Fragment>
      ),
    )}
  </>
)

const iconProps = { size: 14, strokeWidth: 1.5 } as const
const actionClasses = "history-row-action icon-button small dim quiet"

// A row drawn as a terminal's tab is (TerminalTab.tsx), from the same sidebar item: its icon
// and title, then its detail line, a glyph for how it stands (a spinner while it restores) and
// its program, or a plain terminal's folder, with when it closed where a tab holds its
// @handle, and under them the start of its summary, cut to where a search found it. Its
// handle isn't shown: a restore keeps it only where it is still free in the session. A click
// only selects it, as a tab's does; what it can do is its action, which fades in where the
// time was under the pointer, with focus or while it is selected, as a tab's Hide and Rename
// do over its handle: Restore, Show the terminal its conversation is open in, or Connect its
// agent. A right-click opens the same as a menu.
const HistoryRow = ({
  row,
  view,
  typed,
  now,
  icon,
  selected,
  onSelect,
  onRestore,
  onReveal,
  onConnect,
}: {
  row: ClosedTerminal
  view: RowView
  typed: string
  now: number
  icon: ReactNode
  selected: boolean
  onSelect: (row: ClosedTerminal) => void
  onRestore: (row: ClosedTerminal) => void
  onReveal: (terminalId: string) => void
  onConnect: (agent: AgentName) => void
}): React.JSX.Element => {
  const folder = rowFolder(row)
  const { availability } = row
  const program = folder ?? row.program ?? row.agent ?? ""
  const description = [
    view.reason,
    `Closed ${closedFull(row.closedAt, now)}${row.closedBy ? ` by @${row.closedBy}` : ""}`,
  ]
    .filter(Boolean)
    .join(". ")
  const act = (): void => {
    if (view.inert) return
    if (availability.state === "open") onReveal(availability.terminalId)
    else onRestore(row)
  }
  const connect = view.connect
  // What its click does, and the connection it offers instead, as its menu.
  const menu: ContextMenuAction[] =
    availability.state === "open"
      ? [
          {
            value: "show",
            label: `Show ${view.end.text}`,
            icon: <ArrowRight {...iconProps} />,
            onSelect: act,
          },
        ]
      : [
          {
            value: "restore",
            label: "Restore",
            icon: <RotateCcw {...iconProps} />,
            disabled: view.inert,
            onSelect: act,
          },
          ...(connect
            ? [
                {
                  value: "connect",
                  label: `Connect ${agentName(connect)}…`,
                  icon: <Plug {...iconProps} />,
                  onSelect: () => onConnect(connect),
                },
              ]
            : []),
        ]
  const action = connect ? (
    <Tooltip content={`Connect ${agentName(connect)} in Preferences`}>
      <button
        type="button"
        className={actionClasses}
        aria-label={`Connect ${agentName(connect)} in Preferences`}
        onClick={() => onConnect(connect)}
      >
        <Plug {...iconProps} />
      </button>
    </Tooltip>
  ) : view.state === "ready" ? (
    <Tooltip content="Restore">
      <button
        type="button"
        className={actionClasses}
        aria-label={`Restore ${row.title}`}
        onClick={act}
      >
        <RotateCcw {...iconProps} />
      </button>
    </Tooltip>
  ) : view.state === "open" ? (
    <Tooltip content={`Show ${view.end.text}`}>
      <button
        type="button"
        className={actionClasses}
        aria-label={`Show ${row.title} in ${view.end.text}`}
        onClick={act}
      >
        <ArrowRight {...iconProps} />
      </button>
    </Tooltip>
  ) : undefined
  const item = (
    <div className="contents" role="listitem">
      <SidebarItem
        name={row.title}
        icon={icon}
        detail={
          <>
            {/* One glyph wide in every state, so the text beside it never shifts. */}
            <span aria-hidden className="history-glyph inline-block w-[1ch] shrink-0 text-center" />
            <span className="history-row-program truncate">{program}</span>
            <span className="history-row-end sidebar-item-end shrink-0" data-end={view.end.kind}>
              {view.end.text}
            </span>
          </>
        }
        {...(row.summary
          ? {
              below: (
                <span className="history-row-summary truncate">
                  <Lit text={summaryExcerpt(row.summary, typed)} typed={typed} />
                </span>
              ),
            }
          : {})}
        selected={selected}
        selectLabel={labelOf(row, view)}
        tooltip={rowTooltip(row, view, now)}
        description={description}
        onSelect={() => onSelect(row)}
        className="history-row [--_sidebar-actions-space:26px]"
        data-state={view.state}
        data-history-row={row.id}
        {...(selected ? { "data-actions": "shown" } : {})}
        {...(action
          ? {
              actions: (
                <div className="history-row-slot sidebar-item-slot flex items-center">{action}</div>
              ),
            }
          : {})}
      />
    </div>
  )
  return <ContextMenu label={`${row.title} actions`} items={menu} trigger={item} />
}

// The sidebar's History panel: the terminals closed in this project, newest first, with a
// search while there are any. The count beside the title is the matches over the total
// while searching.
const HistoryPanelView = ({
  rows,
  list,
  connections,
  iconOf,
  active,
  onClose,
  onRestore,
  onReveal,
  onConnect,
}: {
  rows: readonly ClosedTerminal[]
  // Reads the project's rows afresh, with their availability checked; the rows follow.
  list: () => Promise<unknown>
  // The agents the backend can connect, where it has them.
  connections: readonly AgentConnection[] | undefined
  iconOf: (row: ClosedTerminal) => ReactNode
  active: boolean
  onClose: () => void
  onRestore: (row: ClosedTerminal) => void
  // Goes to the terminal that holds a conversation, by its handle.
  onReveal: (terminalId: string) => void
  onConnect: (agent: AgentName) => void
}): React.JSX.Element => {
  const [typed, setTyped] = useState("")
  // The row the person selected, by id, while the panel stands; a search that hides it keeps
  // it, and a restored row never comes back under its id.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  // Rows say when they closed against the day it is, which is read when the panel opens.
  const [now, setNow] = useState(() => Date.now())
  // The rows are read when the panel opens, so what the runner checked is what shows.
  // And again when the window is looked at, as another window may have changed what a row needs.
  useEffect(() => {
    if (!active) return
    let current = true
    const read = (): void => {
      list().then(
        () => {
          if (!current) return
          setNow(Date.now())
          setFailed(false)
        },
        () => current && setFailed(true),
      )
    }
    read()
    window.addEventListener("focus", read)
    return () => {
      current = false
      window.removeEventListener("focus", read)
    }
  }, [active, list])
  const matches = rows.filter((row) => rowMatches(row, typed))
  const selectRow = useCallback((row: ClosedTerminal) => setSelectedId(row.id), [])
  const searching = typed.trim() !== ""
  return (
    <SidebarPanel
      id="history-panel"
      title={panelLabels.history}
      count={rows.length === 0 ? "" : searching ? `${matches.length}/${rows.length}` : rows.length}
      active={active}
      onClose={onClose}
    >
      {rows.length > 0 && (
        <label className="field history-search flex h-9 shrink-0 items-center gap-2 px-2.5">
          <Search size={14} className="field-indicator shrink-0" aria-hidden="true" />
          <input
            type="search"
            className="field-input min-w-0 flex-1 text-control"
            aria-label="Find a closed terminal"
            placeholder="Find a closed terminal…"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      )}
      {failed && (
        <p className="history-empty" role="status">
          Couldn’t read the closed terminals. This is what was last heard.
        </p>
      )}
      <div
        className={`history-list ${sidebarListClasses}`}
        role="list"
        aria-label="Closed terminals"
      >
        {matches.map((row) => (
          <HistoryRow
            key={row.id}
            row={row}
            view={rowView(row, now, connections)}
            typed={typed}
            now={now}
            icon={iconOf(row)}
            selected={row.id === selectedId}
            onSelect={selectRow}
            onRestore={onRestore}
            onReveal={onReveal}
            onConnect={onConnect}
          />
        ))}
        {matches.length === 0 && (
          <p className="history-empty" role="status">
            {rows.length === 0
              ? "Terminals you close appear here, so you can bring them back."
              : `No closed terminal matches “${typed.trim()}”.`}
          </p>
        )}
      </div>
    </SidebarPanel>
  )
}

// Drawn again only as its own props change: the sidebar keeps every panel mounted.
export const HistoryPanel = memo(HistoryPanelView)
