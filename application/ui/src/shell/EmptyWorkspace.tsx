import { Plus, Terminal as TerminalIcon } from "lucide-react"

import { backgroundPointerHandlers } from "../layouts/background"
import type { ViewMode } from "../model/types"

export const EmptyWorkspace = ({
  view,
  zen,
  onCreate,
  onShowSessions,
}: {
  view: ViewMode
  zen: boolean
  onCreate: () => void
  onShowSessions: () => void
}): React.JSX.Element => (
  <div
    data-workspace-empty
    className={`empty-workspace flex min-h-0 flex-1 items-center justify-center overflow-auto p-6 text-center text-muted workspace-background ${view === "canvas" || view === "grid" ? "pointer-events-none absolute inset-0 z-10" : "relative"}`}
    {...(view === "canvas" || view === "grid" ? {} : backgroundPointerHandlers)}
  >
    {view !== "canvas" && view !== "grid" && (
      <>
        <div className="workspace-dots absolute inset-0 canvas-grid" aria-hidden="true" />
        <div className="workspace-dots absolute inset-0 canvas-grid-spotlight" aria-hidden="true" />
      </>
    )}
    <section className="empty-state pointer-events-auto relative z-1 flex w-full max-w-96 flex-col items-center rounded-panel border border-line bg-paper p-8 shadow-panel">
      <span className="empty-state-icon mb-4 flex size-11 items-center justify-center rounded-control border border-line bg-shell text-muted">
        <TerminalIcon size={22} strokeWidth={1.4} />
      </span>
      <h2 className="text-base font-medium tracking-tight text-ink">No terminals open</h2>
      <p className="mt-2 max-w-60 text-xs leading-relaxed">
        Open a terminal or pick up a previous session.
      </p>
      <div className="empty-state-actions mt-5 flex flex-wrap items-center justify-center gap-2">
        <button
          className="small-button primary"
          aria-label={zen ? "Create first terminal" : "New terminal"}
          onClick={onCreate}
        >
          <Plus size={14} />
          Terminal
        </button>
        <button
          className="empty-sessions-link rounded-control px-3 py-2 text-[11px] text-muted hover:bg-soft hover:text-ink"
          onClick={onShowSessions}
        >
          Browse sessions
        </button>
      </div>
    </section>
  </div>
)
