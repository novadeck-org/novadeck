import { sidebarListClasses, SidebarItem } from "@novadeck/toolkit/SidebarItem"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { Layers2, Plus } from "lucide-react"

import { shortcutBindings } from "../interaction/shortcuts"
import { statusText } from "../projects/project-status"
import { sessionNeedText, type SessionMark } from "./session-marks"
import { sidebarCreateClasses } from "./SidebarPanel"

type WorkspaceSessionSummary = {
  id: string
  name: string
  // Null until the person first opens it.
  visitedAt: number | null
  terminalNames: string[]
  running: number
  // What its terminals show at a glance; none while they show nothing.
  mark?: SessionMark | undefined
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
          const { mark } = session
          const need = sessionNeedText(mark)
          const lines = mark?.lines ?? []
          const status = mark?.status

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
              badge={
                status && (
                  <span
                    className="session-status flex shrink-0 items-center"
                    data-project-status={status}
                    role="img"
                    aria-label={statusText[status]}
                  >
                    <span className="project-status-mark" aria-hidden="true" />
                  </span>
                )
              }
              description={[visited, ...lines, preview].join(". ")}
              tooltip={[session.name, visited, ...lines, preview].join("\n")}
              onSelect={() => onSelect(session.id)}
              detail={
                <>
                  <span>
                    {terminalCount} {terminalCount === 1 ? "terminal" : "terminals"}
                  </span>
                  {need && <span className="session-running">{need}</span>}
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
