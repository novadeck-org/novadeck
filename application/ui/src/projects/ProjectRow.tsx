import { useSortable } from "@dnd-kit/react/sortable"
import { Check, Pin, PinOff, Trash2 } from "lucide-react"
import { useEffect, useRef } from "react"

import type { Project } from "../model/types"
import { Tooltip } from "../ui-toolkit/Tooltip"
import { statusText, type ProjectStatus } from "./project-status"

// One project's row in the list: its button, and the pin and remove buttons that show
// beside it while the pointer or the focus is on the row.
export const ProjectRow = ({
  project,
  index,
  selected,
  status,
  pinned,
  pinBlocked,
  away,
  removable,
  focusRequest,
  onFocused,
  onSelect,
  onTogglePin,
  onStep,
  onRemove,
}: {
  project: Project
  // Its place in the list, pinned ones first.
  index: number
  selected: boolean
  status: ProjectStatus | undefined
  pinned: boolean
  // No more projects can be pinned.
  pinBlocked: boolean
  // Its drag went to the pins bar, which shows it now: it is unseen here.
  away: boolean
  removable: boolean
  // Asks the row with this id to take the focus, as after a keyboard move or a drag.
  focusRequest: { id: string } | null
  // Told once the row has taken the focus it was asked for.
  onFocused: () => void
  onSelect: () => void
  onTogglePin: () => void
  // Moves the project by one place.
  onStep: (by: -1 | 1) => void
  onRemove: () => void
}): React.JSX.Element => {
  const { ref, handleRef, isDragSource } = useSortable({
    id: project.id,
    index,
    transition: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  })
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (focusRequest?.id !== project.id) return
    button.current?.focus()
    onFocused()
  }, [focusRequest, project.id, onFocused])
  const pinTitle = pinned ? "Unpin project" : "Pin project"
  const pinDisabled = pinBlocked && !pinned
  return (
    <div
      ref={ref}
      className="workspace-switcher-row group relative"
      data-pinned={pinned ? "true" : undefined}
      data-dragging={isDragSource ? "true" : undefined}
      style={away ? { visibility: "hidden" } : undefined}
    >
      <Tooltip content={project.directory} placement="right-start">
        <button
          ref={(node) => {
            button.current = node
            handleRef(node)
          }}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          className={`item standalone workspace-switcher-project flex w-full min-w-0 items-center gap-3 px-2.5 py-[9px] text-left ${removable ? "pr-[70px]" : "pr-10"} ${selected ? "selected" : ""}`}
          type="button"
          aria-current={selected ? "true" : undefined}
          aria-description={status && statusText[status]}
          data-project-status={status}
          onClick={onSelect}
          onKeyDown={(event) => {
            if (!event.altKey) return
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
            event.preventDefault()
            onStep(event.key === "ArrowUp" ? -1 : 1)
          }}
        >
          <span className="workspace-switcher-project-copy flex min-w-0 flex-1 flex-col gap-0.75">
            <strong className="flex min-w-0 items-center gap-1.5 text-body font-medium">
              <span className="truncate">{project.name}</span>
              {pinned && (
                <Pin
                  aria-label="Pinned"
                  className="workspace-switcher-pinned shrink-0"
                  size={11}
                  strokeWidth={1.8}
                />
              )}
            </strong>
            <small className="item-detail truncate text-caption">{project.directory}</small>
          </span>
          {selected && (
            <Check
              aria-label="Current workspace"
              className="shrink-0"
              size={15}
              strokeWidth={1.8}
            />
          )}
          {status && <span aria-hidden="true" className="project-status-mark" />}
        </button>
      </Tooltip>
      <Tooltip content={pinDisabled ? "Unpin a project to pin this one" : pinTitle}>
        {/* A disabled button takes no pointer, so its wrapper carries the tooltip. */}
        <span
          className={`absolute top-1/2 -translate-y-1/2 ${removable ? "right-[38px]" : "right-1.5"}`}
        >
          <button
            className="icon-button workspace-switcher-action size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            type="button"
            aria-label={`${pinned ? "Unpin" : "Pin"} ${project.name}`}
            disabled={pinDisabled}
            onClick={onTogglePin}
          >
            {pinned ? (
              <PinOff aria-hidden="true" size={14} strokeWidth={1.65} />
            ) : (
              <Pin aria-hidden="true" size={14} strokeWidth={1.65} />
            )}
          </button>
        </span>
      </Tooltip>
      {removable && (
        <Tooltip content="Remove project">
          <button
            className="icon-button workspace-switcher-action absolute top-1/2 right-1.5 size-7 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            type="button"
            aria-label={`Remove ${project.name}`}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" size={14} strokeWidth={1.65} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
