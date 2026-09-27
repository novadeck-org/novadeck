import { useSortable } from "@dnd-kit/react/sortable"
import { Check, Eye, EyeOff, Pencil, Terminal as TerminalIcon, X } from "lucide-react"

import { workspaceShortcutBindings } from "../interaction/shortcuts"
import { endingText, terminalEnding } from "../model/terminal-ending"
import type { TerminalMetadata } from "../model/types"
import { SidebarItem } from "../sidebar/SidebarItem"
import { Tooltip } from "../ui-toolkit/Tooltip"
import { TerminalRenameInput, type TerminalRename } from "./TerminalRenameInput"

// Whole class strings, so Tailwind finds them.
const endingDots = { danger: "bg-danger-fg", warning: "bg-warning-fg" } as const

const actionClasses =
  "terminal-tab-action flex size-6 shrink-0 items-center justify-center rounded-control p-1.5 text-muted hover:bg-soft hover:text-ink [&>svg]:opacity-25 [&>svg]:transition-opacity [&>svg]:duration-(--motion-feedback) [&>svg]:ease-interface hover:[&>svg]:opacity-100 focus-visible:[&>svg]:opacity-100"

export const TerminalTab = ({
  terminal,
  index,
  selected,
  hidden,
  rename,
  onVisibilityChange,
  onSelect,
  onBeginRename,
  onRenameDraft,
  onRenameSave,
  onRenameCancel,
  onClose,
}: {
  terminal: TerminalMetadata
  index: number
  selected: boolean
  hidden: boolean
  rename: TerminalRename | null
  onVisibilityChange: (hidden: boolean) => void
  onSelect: () => void
  onBeginRename: () => void
  onRenameDraft: (value: string) => void
  onRenameSave: () => void
  onRenameCancel: () => void
  onClose: () => void
}): React.JSX.Element => {
  const editing = Boolean(rename)
  // A shell that ended shows a dot in its tone; the words go to assistive technology
  // and the tooltip.
  const ending = terminalEnding(terminal)
  const ended = ending ? endingText(ending) : undefined
  const { ref, handleRef, isDragSource } = useSortable({
    id: terminal.id,
    index,
    disabled: editing,
    transition: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  })
  return (
    <div className="contents">
      <SidebarItem
        ref={ref}
        handleRef={handleRef}
        name={terminal.name}
        icon={<TerminalIcon size={14} strokeWidth={1.5} />}
        detail={
          <>
            {ending && (
              <span
                aria-hidden
                data-terminal-ending={ending.tone}
                className={`size-1.5 shrink-0 rounded-full ${endingDots[ending.tone]}`}
              />
            )}
            <span className="terminal-tab-command truncate font-mono">{terminal.command}</span>
          </>
        }
        selected={selected}
        selectLabel={`Select ${terminal.name}${hidden ? " (hidden)" : ""}`}
        tooltip={`${terminal.name}\n${terminal.directory} · ${terminal.command}${ended ? `\n${ended}` : ""}`}
        {...(ended ? { description: ended } : {})}
        onSelect={onSelect}
        data-terminal-tab-id={terminal.id}
        data-terminal-hidden={hidden}

        className={`terminal-tab [--sidebar-actions-space:76px] ${hidden ? "[&_.sidebar-item-select]:opacity-50" : ""} ${selected ? "selected" : ""} ${editing ? "editing" : ""} ${isDragSource ? "dragging" : ""}`}
        editing={editing}
        editor={
          rename ? (
            <div className="terminal-tab-rename flex min-w-0 flex-1 items-start gap-2 px-2.5 py-[9px]">
              <span className="sidebar-item-icon flex h-[18px] w-3.5 shrink-0 items-center justify-center text-muted">
                <TerminalIcon size={14} strokeWidth={1.5} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <TerminalRenameInput
                  id={terminal.id}
                  name={terminal.name}
                  value={rename.value}
                  request={rename.request}
                  autoFocus={rename.origin === "sidebar"}
                  onChange={onRenameDraft}
                  onSave={onRenameSave}
                  onCancel={onRenameCancel}
                  className="w-full border-0 bg-transparent p-0 text-[12px] leading-[18px] font-medium text-ink shadow-none outline-none"
                />
                <span className="sidebar-item-detail flex h-6 min-w-0 items-center overflow-hidden pr-(--sidebar-actions-space) whitespace-nowrap text-[10px] leading-[18px] text-muted">
                  <span className="terminal-tab-command truncate font-mono">
                    {terminal.command}
                  </span>
                </span>
              </div>
            </div>
          ) : undefined
        }
        actions={
          <div className="terminal-tab-actions flex items-center">
            <Tooltip content={hidden ? "Show" : "Hide"}>
              <button
                className={`${actionClasses} disabled:pointer-events-none disabled:opacity-50 ${hidden ? "[&>svg]:opacity-100!" : ""}`}
                aria-label={`${hidden ? "Show" : "Hide"} ${terminal.name} in Grid and Canvas`}
                aria-pressed={hidden}
                disabled={editing}
                onClick={() => onVisibilityChange(!hidden)}
              >
                {hidden ? (
                  <EyeOff size={13} strokeWidth={1.5} />
                ) : (
                  <Eye size={13} strokeWidth={1.5} />
                )}
              </button>
            </Tooltip>
            {editing ? (
              <Tooltip content="Save">
                <button
                  className={actionClasses}
                  data-rename-terminal={terminal.id}
                  aria-label={`Save name for ${terminal.name}`}
                  onClick={onRenameSave}
                >
                  <Check size={13} strokeWidth={1.5} />
                </button>
              </Tooltip>
            ) : (
              <Tooltip
                content={
                  selected
                    ? `Rename · ${workspaceShortcutBindings().rename.display.join(" ")}`
                    : "Rename"
                }
              >
                <button
                  className={actionClasses}
                  aria-label={`Rename ${terminal.name}`}
                  onClick={onBeginRename}
                >
                  <Pencil size={13} strokeWidth={1.5} />
                </button>
              </Tooltip>
            )}
            {editing ? (
              <Tooltip content="Cancel">
                <button
                  className={actionClasses}
                  data-rename-terminal={terminal.id}
                  aria-label={`Cancel renaming ${terminal.name}`}
                  onClick={onRenameCancel}
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content="Close">
                <button
                  className={actionClasses}
                  aria-label={`Close ${terminal.name}`}
                  onClick={onClose}
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              </Tooltip>
            )}
          </div>
        }
      />
    </div>
  )
}
