import { viewModes } from "@novadeck/core/state"
import type { ViewMode } from "@novadeck/core/types"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { views } from "@novadeck/toolkit/views"
import { Bell, ChevronLeft, Plus, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import { shortcutBindings } from "../interaction/shortcuts"
import { BellDot } from "./BellDot"
import type { BellBadge } from "./inbox-badge"

export const ZenDock = ({
  view,
  enabledViews,
  badge,
  onCreate,
  onViewChange,
  onInbox,
  onExit,
}: {
  view: ViewMode
  enabledViews: ViewMode[]
  badge: BellBadge | undefined
  onCreate: () => void
  onViewChange: (view: ViewMode) => void
  onInbox: () => void
  onExit: () => void
}): React.JSX.Element => {
  // Zen starts with the dock unfolded, so its controls are seen once.
  const [open, setOpen] = useState(true)
  // With one view left there's nothing to switch to.
  const switchable = enabledViews.length > 1
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
      <Tooltip content={`New terminal · ${shortcutBindings().newTerminal.display.join(" ")}`}>
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
      {badge && (
        <Tooltip content={`Inbox · ${badge.count} waiting`}>
          <button
            className="icon-button zen-inbox relative"
            aria-label={badge.label}
            data-project-status={badge.status}
            onClick={onInbox}
          >
            <Bell size={16} />
            <BellDot count={badge.count} />
          </button>
        </Tooltip>
      )}
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
          {switchable && (
            <>
              <div
                data-workspace-view-switch
                className="view-switch flex gap-0.5"
                role="group"
                aria-label="Workspace layout"
              >
                {viewModes
                  .filter((id) => enabledViews.includes(id))
                  .map((id) => {
                    const { label, icon: Icon } = views[id]
                    return (
                      <Tooltip key={id} content={label}>
                        <button
                          className="icon-button"
                          aria-label={`${label} view`}
                          aria-pressed={view === id}
                          onClick={() => onViewChange(id)}
                        >
                          <Icon size={16} strokeWidth={1.6} />
                        </button>
                      </Tooltip>
                    )
                  })}
              </div>

              <div className="separator mx-0.5 h-3 w-px" aria-hidden="true" />
            </>
          )}
          <button
            className="icon-button zen-exit w-auto gap-1.5 px-2 py-0 text-control"
            onClick={onExit}
          >
            <X size={14} /> Exit Zen
          </button>
        </div>
      </div>
    </div>
  )
}
