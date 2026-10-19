import { useSortable } from "@dnd-kit/react/sortable"
import { subagentMarks, subagentsBadge, subagentsDetail } from "@novadeck/core/agent-subagents"
import { showsHandle, terminalLabel } from "@novadeck/core/handle"
import { mailBadgeLabel, type MailBadge } from "@novadeck/core/messages"
import { isWindow } from "@novadeck/core/roster"
import {
  attentionText,
  doneText,
  endingText,
  terminalEnding,
  terminalPhase,
  unheardText,
} from "@novadeck/core/terminal-ending"
import { nextTurnAge, turnAge } from "@novadeck/core/turn-age"
import type { Tile } from "@novadeck/core/types"
import { Check, Eye, EyeOff, Pencil, X, type LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import { workspaceShortcutBindings } from "../interaction/shortcuts"
import { SidebarItem } from "../sidebar/SidebarItem"
import { ContextMenu } from "../ui-toolkit/ContextMenu"
import { HandleChip } from "../ui-toolkit/HandleChip"
import { Tooltip } from "../ui-toolkit/Tooltip"
import { SubagentBranches, SubagentLine } from "./TabSubagents"
import { TerminalRenameInput, type TerminalRename } from "./TerminalRenameInput"
import { tabInstructionsId } from "./TerminalTabs"
import { useRenderAt } from "./use-render-at"
import { windowMenu, type DockTarget } from "./window-menu"

const actionClasses = "terminal-tab-action icon-button small dim quiet"
// Hide and Rename wait for the pointer or keyboard focus; Close stays.
const revealedActionClasses = `${actionClasses} terminal-tab-revealed`

export const TerminalTab = ({
  terminal: tile,
  icon: Icon,
  index,
  selected,
  team,
  teamWords,
  hidden,
  unread,
  rename,
  mail = null,
  companion,
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
  // Its place in the selected terminal's team: the lead or one of its workers (tabs.css).
  team?: "lead" | "worker" | undefined
  // Who leads it and whom it leads, in words, for its description: the wire only draws it.
  teamWords?: string | undefined
  hidden: boolean
  // Its agent finished while the person looked elsewhere, on its own or on an error: the
  // tab says so until they look.
  unread?: "done" | "failed" | undefined
  rename: TerminalRename | null
  // What waits for its agent, when anything does: the tab says it in words.
  mail?: MailBadge | null
  // What its companion bar holds, at the end of its name's line.
  companion?: ReactNode
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
  const label = terminalLabel(terminal.name, shell?.handle)
  // The detail line shows the phase: a glyph (a spinner while a program runs) beside
  // the program, or a note while the shell starts. A tab that has ended is hatched (styles.css);
  // assistive technology says how it ended.
  const phase = shell ? terminalPhase(shell, unread !== undefined) : "idle"
  const failed = unread === "failed"
  const ending = shell && terminalEnding(shell)
  const ended = ending ? endingText(ending) : undefined
  // What the agent waits on the person for, or that Novadeck can't hear from it, said like
  // an ending, to assistive technology.
  const waiting = shell && (attentionText(shell) ?? unheardText(shell))
  const note = ended ?? waiting ?? (phase === "done" ? doneText(failed) : undefined)
  const messages = mail ? mailBadgeLabel(mail) : undefined
  // The subagents its agent runs: marked on its line, their kinds under it while selected,
  // and counted in words wherever it marks them.
  const subagents = shell && subagentsBadge(shell)
  const marks = shell && subagentMarks(shell)
  // Their kinds in words, as the marks and rows under the line are only drawn; work its
  // harness only counts has no kinds to name, so its count says it all.
  const counted = shell?.state === "running" && shell.agent?.background !== undefined
  // Work with no subagents in it, as commands left running, has no mark but still counts.
  const kinds =
    subagents && shell
      ? marks && !counted
        ? `${subagents}: ${subagentsDetail(shell)}`
        : subagents
      : undefined
  const said = [note, messages, kinds, teamWords].filter(Boolean).join(", ")
  // Its team's words start lower case, as they follow the others, so lead with a capital.
  const description = said && `${said[0]!.toUpperCase()}${said.slice(1)}`
  const menu = windowMenu({
    terminal,
    onRename: onBeginRename,
    onResetTitle,
    dockIn,
    onClose,
  })
  // How long ago a done tab's agent finished, beside its program, kept current.
  const finished = phase === "done" ? shell : undefined
  const age = finished && turnAge(finished)
  useRenderAt(finished && nextTurnAge(finished))
  // A window runs no program.
  const process = shell?.process ?? ""
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
              className="terminal-glyph inline-block w-[1ch] shrink-0 text-center"
            />
            {phase === "starting" ? (
              <span className="terminal-tab-starting truncate italic">starting…</span>
            ) : phase === "done" ? (
              // How its turn ended is its glyph's (tabs.css), in words its description's;
              // beside its program, how long ago, set apart by colour alone, as the line
              // fits "claude" and "now" but no dot between.
              <>
                <span className="terminal-tab-process truncate">{process}</span>
                {age && <span className="terminal-tab-age shrink-0">{age}</span>}
              </>
            ) : (
              <>
                <span className="terminal-tab-process truncate">{process}</span>
                {marks && <SubagentLine marks={marks} />}
              </>
            )}
            {/* After the program, so the program comes first; where a pointer hovers it
                waits in the slot Hide and Rename slide into (tabs.css). Only on a terminal
                agents name by its handle (core/handle.ts). */}
            <HandleChip
              handle={shell && showsHandle(shell) ? shell.handle : undefined}
              className="handle-plain terminal-tab-handle"
            />
          </>
        }
        {...(marks && !editing ? { below: <SubagentBranches marks={marks} /> } : {})}
        selected={selected}
        emphasized={phase === "done"}
        selectLabel={`Select ${label}${hidden ? " (hidden)" : ""}`}
        {...(description ? { description } : {})}
        {...(companion ? { badge: companion } : {})}
        describedBy={tabInstructionsId}
        onSelect={onSelect}
        data-terminal-tab-id={terminal.id}
        data-terminal-phase={phase}
        {...(phase === "done" && failed ? { "data-terminal-failed": true } : {})}
        {...(phase === "attention" && shell?.state === "running" && shell.agent?.attention
          ? { "data-terminal-attention": shell.agent.attention.kind }
          : {})}
        {...(marks ? { "data-terminal-subagents": marks.working ? "working" : "background" } : {})}
        data-terminal-hidden={hidden}
        {...(team ? { "data-team": team } : {})}

        className={`terminal-tab [--_sidebar-actions-space:76px] ${selected ? "selected" : ""} ${editing ? "editing" : ""} ${isDragSource ? "dragging" : ""}`}
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
              <span className="sidebar-item-icon flex h-[18px] w-3.5 shrink-0 items-center justify-center">
                {icon}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <TerminalRenameInput
                  id={terminal.id}
                  name={terminal.name}
                  label={label}
                  value={rename.value}
                  request={rename.request}
                  autoFocus={rename.origin === "sidebar"}
                  onChange={onRenameDraft}
                  onSave={onRenameSave}
                  onCancel={onRenameCancel}
                  className="terminal-rename-input w-full text-body leading-[18px] font-medium"
                />
                <span className="sidebar-item-detail item-detail flex h-6 min-w-0 items-center overflow-hidden pr-(--_sidebar-actions-space) whitespace-nowrap text-caption leading-[18px]">
                  <span className="terminal-tab-process truncate">{process}</span>
                </span>
              </div>
            </div>
          ) : undefined
        }
        actions={
          <div className="terminal-tab-actions flex items-center">
            {/* Hide and Rename (or Save) share the slot the handle holds at rest. */}
            <div className="terminal-tab-slot flex items-center">
              <Tooltip content={hidden ? "Show" : "Hide"}>
                <button
                  className={revealedActionClasses}
                  aria-label={`${hidden ? "Show" : "Hide"} ${label} in Grid and Canvas`}
                  aria-pressed={hidden}
                  disabled={editing}
                  onClick={() => onVisibilityChange(!hidden)}
                >
                  {hidden ? (
                    <EyeOff size={14} strokeWidth={1.5} />
                  ) : (
                    <Eye size={14} strokeWidth={1.5} />
                  )}
                </button>
              </Tooltip>
              {editing ? (
                <Tooltip content="Save">
                  <button
                    className={actionClasses}
                    data-rename-terminal={terminal.id}
                    aria-label={`Save name for ${label}`}
                    onClick={onRenameSave}
                  >
                    <Check size={14} strokeWidth={1.5} />
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
                    className={revealedActionClasses}
                    aria-label={`Rename ${label}`}
                    onClick={onBeginRename}
                  >
                    <Pencil size={14} strokeWidth={1.5} />
                  </button>
                </Tooltip>
              )}
            </div>
            {editing ? (
              <Tooltip content="Cancel">
                <button
                  className={actionClasses}
                  data-rename-terminal={terminal.id}
                  aria-label={`Cancel renaming ${label}`}
                  onClick={onRenameCancel}
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content="Close">
                <button className={actionClasses} aria-label={`Close ${label}`} onClick={onClose}>
                  <X size={14} strokeWidth={1.5} />
                </button>
              </Tooltip>
            )}
          </div>
        }
      />
    </div>
  )
  return <ContextMenu label={`${label} actions`} items={menu} trigger={tab} />
}
