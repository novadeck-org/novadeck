import { sidebarListClasses, SidebarItem } from "@novadeck/toolkit/SidebarItem"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { Layers2, Plus } from "lucide-react"

import { shortcutBindings } from "../interaction/shortcuts"
import { sidebarCreateClasses } from "./SidebarPanel"

type WorkspaceSessionSummary = {
  id: string
  name: string
  // Null until the person first opens it.
  visitedAt: number | null
  terminalNames: string[]
  running: number
}

type SessionsPanelProps = {
  sessions: WorkspaceSessionSummary[]
  activeId: string
  onSelect: (id: string) => void
  onFresh: () => void
}

const timestamp = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

// The open session is open now, whenever it was last visited.
const formatVisited = (visitedAt: number | null, active: boolean): string =>
  active
    ? "Open now"
    : visitedAt === null
      ? "Not opened yet"
      : `Last visited ${timestamp.format(new Date(visitedAt))}`

export const SessionsPanel = ({
  sessions,
  activeId,
  onSelect,
  onFresh,
}: SessionsPanelProps): React.JSX.Element => {
  const shortcut = shortcutBindings().newSession.display.join(" ")
  return (
    <div className="sessions-panel flex min-h-0 min-w-0 w-full flex-1 flex-col">
      <Tooltip content={`New session · ${shortcut}`}>
        <button
          className={sidebarCreateClasses}
          type="button"
          aria-label="New session"
          data-sessions-create
          onClick={onFresh}
        >
          <Plus size={14} className="shrink-0" />
          <span className="min-w-0 truncate">Session</span>
          <kbd className="hint mb-[-2px] ml-auto shrink-0 whitespace-nowrap">{shortcut}</kbd>
        </button>
      </Tooltip>
      <div
        className={`sessions-panel-list ${sidebarListClasses}`}
        role="list"
        aria-label="Saved sessions"
      >
        {sessions.map((session) => {
          const active = session.id === activeId
          const terminalCount = session.terminalNames.length
          const preview = terminalCount ? session.terminalNames.join(", ") : "No terminals yet"
          const visited = formatVisited(session.visitedAt, active)

          return (
            <SidebarItem
              key={session.id}
              className={`sessions-panel-entry${active ? " active" : ""}`}
              role="listitem"
              data-workspace-session={session.id}
              name={session.name}
              icon={<Layers2 size={14} strokeWidth={1.5} />}
              selected={active}
              selectLabel={`Open ${session.name}`}
              description={`${visited}. ${preview}`}
              tooltip={`${session.name}\n${visited}\n${preview}`}
              onSelect={() => onSelect(session.id)}
              detail={
                <>
                  <span>
                    {terminalCount} {terminalCount === 1 ? "terminal" : "terminals"}
                  </span>
                  {session.running > 0 && (
                    <span className="session-running">{session.running} running</span>
                  )}
                </>
              }
            />
          )
        })}
      </div>
    </div>
  )
}
