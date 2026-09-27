import { Check, ChevronDown, Folder, FolderOpen } from "lucide-react"
import { useState } from "react"

import type { Project } from "../model/types"
import { Popover } from "../ui-toolkit/Popover"

type WorkspaceSwitcherProps = {
  projects: Project[]
  current: Project
  onSelect: (id: string) => void
  // Absent where no folder can be opened, which disables "Open folder…".
  onOpenFolder?: (() => void) | undefined
}

export const WorkspaceSwitcher = ({
  projects,
  current,
  onSelect,
  onOpenFolder,
}: WorkspaceSwitcherProps): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  return (
    <div className="workspace-switcher relative min-w-0 w-fit max-w-[200px] flex-[0_1_auto] max-[700px]:max-w-[130px]">
      <Popover
        label="Switch workspace"
        open={open}
        onOpenChange={setOpen}
        className="workspace-switcher-menu w-[min(280px,calc(100vw-24px))]"
        trigger={
          <button
            className="workspace-switcher-trigger inline-flex min-h-9 min-w-0 w-full max-w-full items-center gap-1.5 rounded-control px-2.5 text-[12px] leading-[1.5] font-medium text-ink transition-[background] duration-(--motion-feedback) hover:bg-soft aria-expanded:bg-soft"
            type="button"
            aria-label="Switch workspace"
            title={current.directory}
          >
            <Folder
              aria-hidden="true"
              className="shrink-0 text-muted"
              size={14}
              strokeWidth={1.55}
            />
            <span className="min-w-0 flex-1 truncate">{current.name}</span>
            <ChevronDown
              aria-hidden="true"
              className="shrink-0 text-muted"
              size={14}
              strokeWidth={1.75}
            />
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
              <button
                key={project.id}
                className={`workspace-switcher-project flex w-full min-w-0 items-center gap-3 rounded-control border border-transparent px-2.5 py-[9px] text-left text-ink hover:bg-shell focus-visible:bg-shell focus-visible:outline-offset-[-2px] ${selected ? "selected" : ""}`}
                type="button"
                aria-current={selected ? "true" : undefined}
                title={project.directory}
                onClick={() => {
                  onSelect(project.id)
                  setOpen(false)
                }}
              >
                <span className="workspace-switcher-project-copy flex min-w-0 flex-1 flex-col gap-0.75">
                  <strong className="truncate text-[12px] font-medium">{project.name}</strong>
                  <small className="truncate font-mono text-[10px] text-muted">
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
            )
          })}
        </div>
        <div className="workspace-switcher-footer border-t border-line p-[5px]">
          <button
            className="workspace-switcher-new flex w-full items-center gap-2.25 rounded-control px-2.5 py-[9px] text-left text-[11px] text-muted disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            disabled={!onOpenFolder}
            title={onOpenFolder ? undefined : "Unavailable"}
            onClick={() => {
              setOpen(false)
              onOpenFolder?.()
            }}
          >
            <FolderOpen aria-hidden="true" className="shrink-0" size={15} strokeWidth={1.65} />
            <span>Open folder…</span>
          </button>
        </div>
      </Popover>
    </div>
  )
}
