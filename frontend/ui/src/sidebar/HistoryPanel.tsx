import type { AgentName } from "@novadeck/core/harnesses"
import type { ClosedTerminal } from "@novadeck/core/history"
import type { AgentConnection } from "@novadeck/core/port"
import {
  sidebarListClasses,
  sidebarRowClasses,
  sidebarRowIconClasses,
  sidebarRowNameClasses,
  sidebarRowSelectClasses,
} from "@novadeck/toolkit/SidebarItem"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { Plug, RotateCcw, Search } from "lucide-react"
import { Fragment, useEffect, useId, useState, type ReactNode } from "react"

import {
  agentName,
  closedFull,
  foundBySummary,
  litPieces,
  rowFolder,
  rowMatches,
  rowTooltip,
  rowView,
  summaryExcerpt,
  type RowView,
} from "./history-rows"
import { SidebarPanel } from "./SidebarPanel"

// A row's accessible name: what its click does, and for a row that does nothing, what it is.
const labelOf = (row: ClosedTerminal, view: RowView): string => {
  switch (view.state) {
    case "ready":
      return `Restore ${row.title}`
    case "open":
      return `Show ${row.title}, open as ${view.end.kind === "handle" ? view.end.text : ""}`
    case "restoring":
      return `${row.title}, restoring`
    case "gone":
      return `${row.title}, unavailable`
    case "disconnected":
      return `${row.title}, not connected`
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

const HistoryRow = ({
  row,
  view,
  typed,
  now,
  icon,
  onRestore,
  onReveal,
  onConnect,
}: {
  row: ClosedTerminal
  view: RowView
  typed: string
  now: number
  icon: ReactNode
  onRestore: (row: ClosedTerminal) => void
  onReveal: (terminalId: string) => void
  onConnect: (agent: AgentName) => void
}): React.JSX.Element => {
  const descriptionId = useId()
  const folder = rowFolder(row)
  const { availability } = row
  const description = [
    view.reason,
    `Closed ${closedFull(row.closedAt, now)}${row.closedBy ? ` by @${row.closedBy}` : ""}`,
  ]
    .filter(Boolean)
    .join(". ")
  return (
    <div
      role="listitem"
      className={`${sidebarRowClasses} history-row`}
      data-state={view.state}
      data-history-row={row.id}
    >
      <Tooltip content={rowTooltip(row, view, now)} placement="right-start">
        <button
          type="button"
          className={`${sidebarRowSelectClasses} history-row-select`}
          aria-label={labelOf(row, view)}
          aria-describedby={descriptionId}
          aria-disabled={view.inert || undefined}
          onClick={() => {
            if (view.inert) return
            if (availability.state === "open") onReveal(availability.terminalId)
            else onRestore(row)
          }}
        >
          <span className={sidebarRowIconClasses}>{icon}</span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="history-row-line">
              <span className={`${sidebarRowNameClasses()} min-w-0 flex-1`}>
                {row.title}
                {folder && <span className="history-row-folder item-detail">{folder}</span>}
              </span>
              <span className="history-row-end" data-open={view.state === "open"}>
                {view.end.kind === "restoring" ? (
                  <span className="history-spinner" aria-hidden="true" />
                ) : (
                  <>
                    <span className="history-row-end-text">{view.end.text}</span>
                    {view.state === "ready" && (
                      <RotateCcw className="history-row-restore" size={14} strokeWidth={1.6} />
                    )}
                  </>
                )}
              </span>
            </span>
            {foundBySummary(row, typed) && (
              <span className="history-row-summary">
                <Lit text={summaryExcerpt(row.summary!, typed)} typed={typed} />
              </span>
            )}
          </span>
        </button>
      </Tooltip>
      <span id={descriptionId} hidden>
        {description}
      </span>
      {view.connect && (
        <div className="history-row-actions">
          <Tooltip content={`Connect ${agentName(view.connect)} in Preferences`}>
            <button
              type="button"
              className="icon-button small dim quiet"
              aria-label={`Connect ${agentName(view.connect)} in Preferences`}
              onClick={() => onConnect(view.connect!)}
            >
              <Plug size={14} strokeWidth={1.6} />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  )
}

// The sidebar's History panel: the terminals closed in this project, newest first, with a
// search while there are any. The count beside the title is the matches over the total
// while searching.
export const HistoryPanel = ({
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
  const searching = typed.trim() !== ""
  return (
    <SidebarPanel
      id="history-panel"
      title="History"
      count={rows.length === 0 ? "" : searching ? `${matches.length}/${rows.length}` : rows.length}
      active={active}
      onClose={onClose}
    >
      {rows.length > 0 && (
        <label className="field quiet history-search flex h-9 shrink-0 items-center gap-2 px-2">
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
            onRestore={onRestore}
            onReveal={onReveal}
            onConnect={onConnect}
          />
        ))}
        {matches.length === 0 && (
          <p className="history-empty" role="status">
            {rows.length === 0
              ? "Terminals you close show up here, so you can bring them back."
              : `No closed terminal matches “${typed.trim()}”.`}
          </p>
        )}
      </div>
    </SidebarPanel>
  )
}
