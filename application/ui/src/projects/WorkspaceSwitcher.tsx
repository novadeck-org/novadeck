import { Check, ChevronDown, Folder, FolderOpen, Trash2 } from "lucide-react"
import { useRef, useState } from "react"

import type { Project } from "../model/types"
import { ConfirmDialog } from "../ui-toolkit/ConfirmDialog"
import { Popover } from "../ui-toolkit/Popover"
import { Tooltip } from "../ui-toolkit/Tooltip"

type WorkspaceSwitcherProps = {
  projects: Project[]
  current: Project
  onSelect: (id: string) => void
  // Absent where no folder can be opened, which disables "Open folder…".
  onOpenFolder?: (() => void) | undefined
  // Removes a project after the person confirms; absent where projects can't be removed.
  onRemove?: ((id: string) => void) | undefined
}

export const WorkspaceSwitcher = ({
  projects,
  current,
  onSelect,
  onOpenFolder,
  onRemove,
}: WorkspaceSwitcherProps): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  // The project waiting on the person's answer to removing it.
  const [removing, setRemoving] = useState<Project | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  // The last project stays: the workspace always has one.
  const removable = Boolean(onRemove) && projects.length > 1
  return (
    <div className="workspace-switcher relative min-w-0 w-fit max-w-[200px] flex-[0_1_auto] max-[700px]:max-w-[130px]">
      <Popover
        tooltip={current.directory}
        label="Switch workspace"
        open={open}
        onOpenChange={setOpen}
        className="workspace-switcher-menu w-[min(280px,calc(100vw-24px))]"
        trigger={
          <button
            ref={trigger}
            className="button ghost workspace-switcher-trigger inline-flex min-h-9 min-w-0 w-full max-w-full items-center justify-start gap-1.5 px-[9px] text-body leading-[1.5] font-medium"
            type="button"
            aria-label="Switch workspace"
          >
            <Folder aria-hidden="true" className="shrink-0" size={14} strokeWidth={1.55} />
            <span className="min-w-0 flex-1 truncate">{current.name}</span>
            <ChevronDown aria-hidden="true" className="shrink-0" size={14} strokeWidth={1.75} />
          </button>
        }
      >
        <div
          className="workspace-switcher-projects flex max-h-[min(280px,calc(100vh-150px))] flex-col gap-1 overflow-y-auto p-[5px]"
          aria-label="Workspaces"
        >
          {projects.map((project) => {
            const selected = project.id === current.id
            return (
              <div key={project.id} className="workspace-switcher-row group relative">
                <Tooltip content={project.directory} placement="right-start">
                  <button
                    className={`item workspace-switcher-project flex w-full min-w-0 items-center gap-3 px-2.5 py-[9px] text-left ${removable ? "pr-10" : ""} ${selected ? "selected" : ""}`}
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => {
                      onSelect(project.id)
                      setOpen(false)
                    }}
                  >
                    <span className="workspace-switcher-project-copy flex min-w-0 flex-1 flex-col gap-0.75">
                      <strong className="truncate text-body font-medium">{project.name}</strong>
                      <small className="item-detail truncate text-caption">
                        {project.directory}
                      </small>
                    </span>
                    {selected && (
                      <Check
                        aria-label="Current workspace"
                        className="shrink-0"
                        size={15}
                        strokeWidth={1.8}
                      />
                    )}
                  </button>
                </Tooltip>
                {removable && (
                  <Tooltip content="Remove project">
                    <button
                      className="icon-button workspace-switcher-remove absolute top-1/2 right-1.5 size-7 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      type="button"
                      aria-label={`Remove ${project.name}`}
                      onClick={() => {
                        setOpen(false)
                        setRemoving(project)
                      }}
                    >
                      <Trash2 aria-hidden="true" size={14} strokeWidth={1.65} />
                    </button>
                  </Tooltip>
                )}
              </div>
            )
          })}
        </div>
        {/* A disabled button takes no pointer, so its footer says why it's unavailable. */}
        <Tooltip content="Unavailable" disabled={Boolean(onOpenFolder)}>
          <div className="workspace-switcher-footer p-[5px]">
            <button
              className="button quiet workspace-switcher-new h-auto w-full justify-start gap-2.25 px-[9px] py-2 text-left text-control disabled:cursor-not-allowed"
              type="button"
              disabled={!onOpenFolder}
              onClick={() => {
                setOpen(false)
                onOpenFolder?.()
              }}
            >
              <FolderOpen aria-hidden="true" className="shrink-0" size={15} strokeWidth={1.65} />
              <span>Open folder…</span>
            </button>
          </div>
        </Tooltip>
      </Popover>
      <ConfirmDialog
        subject={removing}
        title={(shown) => `Remove “${shown.name}”?`}
        description={() => "Its terminals close. The folder on disk stays as it is."}
        confirmLabel="Remove project"
        cancelLabel="Cancel"
        onConfirm={() => {
          if (removing) onRemove?.(removing.id)
          setRemoving(null)
        }}
        onCancel={() => setRemoving(null)}
        returnFocus={() => trigger.current}
        widthClassName="w-[min(360px,calc(100vw-32px))]"
      />
    </div>
  )
}
