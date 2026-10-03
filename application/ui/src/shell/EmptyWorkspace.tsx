import { Plus } from "lucide-react"

import { backgroundPointerHandlers } from "../layouts/background"
import type { ViewMode } from "../model/types"
import { DeckMark } from "../ui-toolkit/DeckLogo"

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
    className={`empty-workspace flex min-h-0 flex-1 items-center justify-center overflow-auto p-6 text-center workspace-background ${view === "canvas" || view === "grid" ? "pointer-events-none absolute inset-0 z-10" : "relative"}`}
    {...(view === "canvas" || view === "grid" ? {} : backgroundPointerHandlers)}
  >
    {view !== "canvas" && view !== "grid" && (
      <>
        <div className="workspace-dots absolute inset-0 canvas-grid" aria-hidden="true" />
        <div className="workspace-dots absolute inset-0 canvas-grid-spotlight" aria-hidden="true" />
      </>
    )}
    <section className="panel empty-state pointer-events-auto relative z-1 flex w-full max-w-96 flex-col items-center p-8">
      <DeckMark size={44} className="empty-state-icon mb-4" />
      <h2 className="empty-state-title text-base font-medium">No terminals open</h2>
      <p className="empty-state-description mt-2 max-w-60 text-xs leading-relaxed">
        Open a terminal or pick up a previous session.
      </p>
      <div className="empty-state-actions mt-5 flex flex-wrap items-center justify-center gap-2">
        <button
          className="button primary"
          aria-label={zen ? "Create first terminal" : "New terminal"}
          onClick={onCreate}
        >
          <Plus size={14} />
          Terminal
        </button>
        <button
          className="button quiet empty-sessions-link h-auto px-[11px] py-[7px] text-[11px]"
          onClick={onShowSessions}
        >
          Browse sessions
        </button>
      </div>
    </section>
  </div>
)
