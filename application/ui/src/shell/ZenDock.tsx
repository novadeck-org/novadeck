import { ChevronLeft, LayoutGrid, PanelLeft, Plus, SquareDashedMousePointer, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import { workspaceShortcutBindings } from "../interaction/shortcuts"
import type { ViewMode } from "../model/types"
import { Tooltip } from "../ui-toolkit/Tooltip"

const views = [
  { id: "focus", label: "Focus", icon: PanelLeft },
  { id: "grid", label: "Grid", icon: LayoutGrid },
  { id: "canvas", label: "Canvas", icon: SquareDashedMousePointer },
] as const

export const ZenDock = ({
  view,
  enabledViews,
  onCreate,
  onViewChange,
  onExit,
}: {
  view: ViewMode
  enabledViews: ViewMode[]
  onCreate: () => void
  onViewChange: (view: ViewMode) => void
  onExit: () => void
}): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const dock = useRef<HTMLDivElement>(null)
  const create = useRef<HTMLButtonElement>(null)
  const controls = useId()
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !dock.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener("pointerdown", dismiss)
    return () => document.removeEventListener("pointerdown", dismiss)
  }, [open])
  return (
    <div
      className="zen-dock absolute right-5 bottom-5 z-40 flex flex-row-reverse items-center gap-0.5 p-1 max-[701px]:right-3 max-[701px]:bottom-3"
      ref={dock}
      data-open={open}
      data-workspace-zen-dock
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return
        event.preventDefault()
        event.stopPropagation()
        create.current?.focus({ preventScroll: true })
        setOpen(false)
      }}
      role="group"
      aria-label="Zen controls"
    >
      <Tooltip
        content={`New terminal · ${workspaceShortcutBindings().newTerminal.display.join(" ")}`}
      >
        <button
          ref={create}
          data-workspace-zen-create
          className="zen-create icon-button"
          aria-label="New terminal"
          onClick={onCreate}
        >
          <Plus size={16} />
        </button>
      </Tooltip>
      <button
        className="icon-button zen-reveal w-5 p-0"
        aria-label={open ? "Hide Zen controls" : "Show Zen controls"}
        aria-expanded={open}
        aria-controls={controls}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronLeft size={12} className={open ? "rotate-180" : ""} />
      </button>
      <div className="zen-dock-reveal" inert={!open} aria-hidden={!open} id={controls}>
        <div className="zen-dock-actions flex min-w-0 items-center gap-0.5 overflow-hidden whitespace-nowrap">
          <div
            data-workspace-view-switch
            className="view-switch flex gap-0.5"
            role="group"
            aria-label="Workspace layout"
          >
            {views
              .filter(({ id }) => enabledViews.includes(id))
              .map(({ id, label, icon: Icon }) => (
                <Tooltip key={id} content={label}>
                  <button
                    className="icon-button"
                    aria-label={`${label} view`}
                    aria-pressed={view === id}
                    onClick={() => onViewChange(id)}
                  >
                    <Icon size={15} strokeWidth={1.6} />
                  </button>
                </Tooltip>
              ))}
          </div>

          <div className="separator mx-0.5 h-3 w-px" aria-hidden="true" />
          <button
            className="icon-button zen-exit w-auto gap-1.5 px-2 py-0 text-[11px]"
            onClick={onExit}
          >
            <X size={14} /> Exit Zen
          </button>
        </div>
      </div>
    </div>
  )
}
