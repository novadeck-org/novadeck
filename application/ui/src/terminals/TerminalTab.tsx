import { useSortable } from "@dnd-kit/react/sortable"
import { Check, Eye, EyeOff, Pencil, X, type LucideIcon } from "lucide-react"

import { workspaceShortcutBindings } from "../interaction/shortcuts"
import { subagentsBadge, subagentsDetail } from "../model/agent-subagents"
import { nextReset, usageDetail } from "../model/agent-usage"
import { mailBadgeLabel, type MailBadge } from "../model/messages"
import { isWindow } from "../model/roster"
import { attentionText, endingText, terminalEnding, terminalPhase } from "../model/terminal-ending"
import { titleSourceText } from "../model/title-source"
import type { Tile } from "../model/types"
import { SidebarItem } from "../sidebar/SidebarItem"
import { ContextMenu } from "../ui-toolkit/ContextMenu"
import { Tooltip } from "../ui-toolkit/Tooltip"
import { MailCount } from "./MailCount"
import { TerminalRenameInput, type TerminalRename } from "./TerminalRenameInput"
import { useRenderAt } from "./use-render-at"
import { windowMenu, type DockTarget } from "./window-menu"

const actionClasses =
  "terminal-tab-action flex size-6 shrink-0 items-center justify-center rounded-control p-1.5 text-muted hover:bg-soft hover:text-ink [&>svg]:opacity-25 [&>svg]:transition-opacity [&>svg]:duration-(--motion-feedback) [&>svg]:ease-interface hover:[&>svg]:opacity-100 focus-visible:outline-offset-[-2px] focus-visible:[&>svg]:opacity-100"

export const TerminalTab = ({
  terminal: tile,
  icon: Icon,
  index,
  selected,
  hidden,
  rename,
  mail = null,
  onVisibilityChange,
  onSelect,
  onBeginRename,
  onRenameDraft,
  onRenameSave,
  onRenameCancel,
  onClose,
  onResetTitle,
  dockIn,
}: {
  // A terminal, or a window undocked from a companion, which runs nothing.
  terminal: Tile
  // What it presents as: its program, or what the window shows.
  icon: LucideIcon
  index: number
  selected: boolean
  hidden: boolean
  rename: TerminalRename | null
  // What waits for its agent, when anything does.
  mail?: MailBadge | null
  onVisibilityChange: (hidden: boolean) => void
  onSelect: () => void
  onBeginRename: () => void
  onRenameDraft: (value: string) => void
  onRenameSave: () => void
  onRenameCancel: () => void
  onClose: () => void
  // Hands the name back to the backend; absent where it can't.
  onResetTitle?: (() => void) | undefined
  // Docks a window undocked from a terminal's companion back in that terminal.
  dockIn?: DockTarget | undefined
}): React.JSX.Element => {
  const editing = Boolean(rename)
  const terminal = tile
  const shell = isWindow(tile) ? undefined : tile
  const icon = <Icon size={14} strokeWidth={1.5} />
  // The detail line shows the phase: a glyph (a spinner while a program runs) beside
  // the program, or a note while the shell starts. A tab that has ended is hatched (styles.css); the
  // tooltip and assistive technology say how it ended.
  const phase = shell ? terminalPhase(shell) : "idle"
  const ending = shell && terminalEnding(shell)
  const ended = ending ? endingText(ending) : undefined
  // What the agent waits on the person for, said like an ending: in the tooltip and to
  // assistive technology.
  const waiting = shell && attentionText(shell)
  const note = ended ?? waiting
  const named = terminal.titleSource ? titleSourceText(terminal.titleSource) : undefined
  const messages = mail ? mailBadgeLabel(mail) : undefined
  const description = [note, messages].filter(Boolean).join(", ")
  const menu = windowMenu({
    terminal,
    onRename: onBeginRename,
    onResetTitle,
    dockIn,
    onClose,
  })
  useRenderAt(shell && nextReset(shell))
  const usage = shell && usageDetail(shell)
  const subagents = shell && subagentsBadge(shell)
  const subagentKinds = shell && subagents ? `${subagents}: ${subagentsDetail(shell)}` : undefined
  const planning = shell?.state === "running" && shell.agent?.planning ? "Planning" : undefined
  // A window runs no program; its tab says where it came from instead.
  const process = shell?.process ?? ""
  const place = shell ? `${shell.directory} · ${shell.process}` : "Undocked window"
  const { ref, handleRef, isDragSource } = useSortable({
    id: terminal.id,
    index,
    disabled: editing,
    transition: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  })
  const tab = (
    <div className="contents">
      <SidebarItem
        ref={ref}
        handleRef={handleRef}
        name={terminal.name}
        icon={icon}
        detail={
          <>
            {/* One glyph wide in every phase, so the text beside it never shifts. */}
            <span
              aria-hidden
              className="terminal-glyph inline-block w-[1ch] shrink-0 text-center font-mono text-ink"
            />
            {phase === "starting" ? (
              <span className="terminal-tab-starting truncate font-mono italic">starting…</span>
            ) : (
              <span
                className={`terminal-tab-process truncate font-mono ${phase === "running" || phase === "attention" ? "text-ink" : ""}`}
              >
                {process}
              </span>
            )}
          </>
        }
        selected={selected}
        selectLabel={`Select ${terminal.name}${hidden ? " (hidden)" : ""}`}
        tooltip={`${terminal.name}${named ? `\n${named}` : ""}\n${place}${note ? `\n${note}` : ""}${messages ? `\n${messages}` : ""}${planning ? `\n${planning}` : ""}${subagentKinds ? `\n${subagentKinds}` : ""}${usage ? `\n${usage}` : ""}`}
        {...(description ? { description } : {})}
        {...(mail ? { badge: <MailCount badge={mail} /> } : {})}
        onSelect={onSelect}
        data-terminal-tab-id={terminal.id}
        data-terminal-phase={phase}
        {...(phase === "attention" && shell?.state === "running" && shell.agent?.attention
          ? { "data-terminal-attention": shell.agent.attention.kind }
          : {})}
        data-terminal-hidden={hidden}

        className={`terminal-tab [--sidebar-actions-space:76px] ${hidden ? "[&_.sidebar-item-select]:opacity-50" : ""} ${selected ? "selected" : ""} ${editing ? "editing" : ""} ${isDragSource ? "dragging" : ""}`}
        editing={editing}
        editor={
          rename ? (
            <div
              className="terminal-tab-rename flex min-w-0 flex-1 items-start gap-2 px-2.5 py-[9px] select-text"
              // A right-click or a touch held here belongs to the field, never the tab's menu.
              onContextMenu={(event) => event.stopPropagation()}
              onPointerDown={(event) => {
                if (event.pointerType !== "mouse") event.stopPropagation()
              }}
            >
              <span className="sidebar-item-icon flex h-[18px] w-3.5 shrink-0 items-center justify-center text-muted">
                {icon}
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
                  <span className="terminal-tab-process truncate font-mono">{process}</span>
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
  return <ContextMenu label={`${terminal.name} actions`} items={menu} trigger={tab} />
}
