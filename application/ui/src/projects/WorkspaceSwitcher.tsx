import { ChevronDown, Folder, FolderOpen } from "lucide-react"
import { useRef, useState } from "react"

import type { Project } from "../model/types"
import { ConfirmDialog } from "../ui-toolkit/ConfirmDialog"
import { Popover } from "../ui-toolkit/Popover"
import { Tooltip } from "../ui-toolkit/Tooltip"
import type { ProjectArrangement } from "./project-arrangement"
import { elsewhereStatus, statusText, type ProjectStatus } from "./project-status"
import { ProjectList } from "./ProjectList"

type WorkspaceSwitcherProps = {
  projects: Project[]
  current: Project
  // What each project's terminals show, by its id, where they show anything.
  statuses: Readonly<Record<string, ProjectStatus>>
  // How the person arranged the projects, and how each change is asked for: `onMove` puts
  // a project at a place in the list (pinned ones first), `onStep` moves it one place,
  // pinning or unpinning it where it crosses the rule.
  arrangement: ProjectArrangement
  // Projects the button's dot leaves out, as the header shows their status itself.
  dotIgnores: readonly string[]
  onSelect: (id: string) => void
  onMove: (id: string, index: number) => void
  onStep: (id: string, by: -1 | 1) => void
  onTogglePin: (id: string) => void
  // Absent where no folder can be opened, which disables "Open folder…".
  onOpenFolder?: (() => void) | undefined
  // Removes a project after the person confirms; absent where projects can't be removed.
  onRemove?: ((id: string) => void) | undefined
}

export const WorkspaceSwitcher = ({
  projects,
  current,
  statuses,
  arrangement,
  dotIgnores,
  onSelect,
  onMove,
  onStep,
  onTogglePin,
  onOpenFolder,
  onRemove,
}: WorkspaceSwitcherProps): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  // The project waiting on the person's answer to removing it.
  const [removing, setRemoving] = useState<Project | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  // The last project stays: the workspace always has one.
  const removable = Boolean(onRemove) && projects.length > 1
  // What another project has waiting on the person, marked on the button.
  const elsewhere = elsewhereStatus(statuses, current.id, dotIgnores)
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
            className="button ghost workspace-switcher-trigger relative inline-flex min-h-9 min-w-0 w-full max-w-full items-center justify-start gap-1.5 px-[9px] text-body leading-[1.5] font-medium"
            type="button"
            aria-label="Switch workspace"
            aria-description={elsewhere && `Another project: ${statusText[elsewhere]}`}
            data-project-status={elsewhere}
          >
            {elsewhere && (
              <span aria-hidden="true" className="project-status-dot workspace-switcher-dot" />
            )}
            <Folder aria-hidden="true" className="shrink-0" size={14} strokeWidth={1.55} />
            <span className="min-w-0 flex-1 truncate">{current.name}</span>
            <ChevronDown aria-hidden="true" className="shrink-0" size={14} strokeWidth={1.75} />
          </button>
        }
      >
        <ProjectList
          projects={projects}
          current={current.id}
          statuses={statuses}
          arrangement={arrangement}
          removable={removable}
          onSelect={(id) => {
            onSelect(id)
            setOpen(false)
          }}
          onMove={onMove}
          onStep={onStep}
          onTogglePin={onTogglePin}
          onRemove={(project) => {
            setOpen(false)
            setRemoving(project)
          }}
        />
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
