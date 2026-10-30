import { useSortable } from "@dnd-kit/react/sortable"
import { subagentMarks, subagentsBadge, subagentsDetail } from "@novadeck/core/agents/subagents"
import { nextTurnAge, turnAge } from "@novadeck/core/agents/turn-age"
import {
  clockTime,
  nextWaitingChange,
  waitingOf,
  wakeFill,
  wakePassed,
} from "@novadeck/core/agents/waiting"
import { messageBadgeLabel, type MessageBadge } from "@novadeck/core/messages"
import { isWindow } from "@novadeck/core/roster"
import {
  endingText,
  idleNote,
  pausedUntil,
  terminalEnding,
  terminalNote,
  type NeedDialog,
} from "@novadeck/core/terminals/ending"
import { showsHandle, terminalLabel } from "@novadeck/core/terminals/handle"
import type { Tile } from "@novadeck/core/types"
import { ContextMenu } from "@novadeck/toolkit/ContextMenu"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { SidebarItem } from "@novadeck/toolkit/SidebarItem"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { Check, Eye, EyeOff, Pencil, X, type LucideIcon } from "lucide-react"
import { lazy, Suspense, type ReactNode } from "react"

import { workspaceShortcutBindings } from "../interaction/shortcuts"
import { isProjectWindow } from "./project-window"
import { SubagentBranches, SubagentLine } from "./TabSubagents"
import { TerminalRenameInput, type TerminalRename } from "./TerminalRenameInput"
import { tabInstructionsId } from "./TerminalTabs"
import { useRenderAt } from "./useRenderAt"
import { windowMenu, type AskFeedback, type DockTarget, type ReleaseLead } from "./window-menu"

// What a waiting agent's tab draws beyond its glyph loads when one waits, as most never do.
const WaitingBranches = lazy(() =>
  import("./TabWaiting").then((module) => ({ default: module.WaitingBranches })),
)
const WakePassed = lazy(() =>
  import("./TabWaiting").then((module) => ({ default: module.WakePassed })),
)

// A sentence of the description, its first letter a capital.
const capital = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`

const actionClasses = "terminal-tab-action icon-button small dim quiet"
// Hide and Rename wait for the pointer or keyboard focus; Close stays.
const revealedActionClasses = `${actionClasses} terminal-tab-revealed`

export const TerminalTab = ({
  terminal,
  icon: Icon,
  index,
  selected,
  team,
  teamWords,
  hidden,
  unread,
  need: inboxNeed,
  needSubject,
  needDialog,
  rename,
  messageBadge = null,
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
  askFeedback,
  releaseLead,
  folder,
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
  // Its agent ended a turn while the person looked elsewhere: on its own, which brightens
  // its program, or on an error, which marks it failed, until they look.
  unread?: "unread" | "failed" | undefined
  // What the Inbox says it needs of the person (`unblock` or `ask`), the subject of the Inbox
  // entry behind it. The agent's live dialog adds its own need.
  need?: "unblock" | "ask" | undefined
  needSubject?: string | undefined
  needDialog?: NeedDialog | undefined
  rename: TerminalRename | null
  // What waits for its agent, when anything does: the tab says it in words.
  messageBadge?: MessageBadge | null
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
  // Asks the window's agent to write feedback; absent for a window that runs none.
  askFeedback?: AskFeedback | undefined
  // Ends the lead of a terminal an agent leads; absent for any other.
  releaseLead?: ReleaseLead | undefined
  // Where a project window's file is, which its line shows where a terminal's program is.
  folder?: string | undefined
}): React.JSX.Element => {
  const editing = Boolean(rename)
  const shell = isWindow(terminal) ? undefined : terminal
  const icon = <Icon size={14} strokeWidth={1.5} />
  const label = terminalLabel(terminal.name, shell?.handle)
  // The detail line shows the state: a glyph (a spinner while a program runs) before the
  // program, what the agent needs of the person right after it, or a note while the shell
  // starts. A tab that has ended is hatched (styles.css); assistive technology says how it
  // ended.
  const { phase, need, failed, brightened, text } = shell
    ? terminalNote(shell, { need: inboxNeed, subject: needSubject, dialog: needDialog }, unread)
    : idleNote
  const ending = shell && terminalEnding(shell)
  const ended = ending ? endingText(ending) : undefined
  const resets = shell && phase === "paused" ? pausedUntil(shell) : undefined
  // What an idle agent waits on, which wakes it by itself, or the wake-up that passed
  // without a new turn: the glyph and the rows under the line say it.
  const waits = phase === "waiting" && shell ? waitingOf(shell) : undefined
  const passed = shell && (phase === "idle" || phase === "done") ? wakePassed(shell) : undefined
  const note = ended ?? text
  const messages = messageBadge ? messageBadgeLabel(messageBadge) : undefined
  // The subagents its agent runs: marked on its line, their kinds under it while selected,
  // and counted in words wherever it marks them.
  const subagents = shell && subagentsBadge(shell)
  const marks = shell && subagentMarks(shell)
  // Their kinds in words, as the marks and rows under the line are only drawn; work its
  // harness only counts has no kinds to name, so its count says it all.
  const counted = shell?.state === "running" && shell.agent?.background !== undefined
  // Work with no subagents in it, as commands left running, has no mark but still counts.
  // The wait names a command it left running, so its count adds nothing.
  const kinds =
    subagents && shell && !(waits && !marks)
      ? marks && !counted
        ? `${subagents}: ${subagentsDetail(shell)}`
        : subagents
      : undefined
  // Its team is a sentence of its own, so it isn't heard as one more of a list before it.
  const description = [[note, messages, kinds].filter(Boolean).join(", "), teamWords]
    .filter(Boolean)
    .map((part) => capital(part!))
    .join(". ")
  const menu = windowMenu({
    terminal,
    onRename: onBeginRename,
    onResetTitle,
    dockIn,
    askFeedback,
    releaseLead,
    onClose,
  })
  // How long ago a done tab's agent finished, beside its program, kept current.
  const finished = phase === "done" ? shell : undefined
  const age = finished && turnAge(finished)
  useRenderAt(finished ? nextTurnAge(finished) : waits && shell ? nextWaitingChange(shell) : resets)
  // A window runs no program; a project window names its file's folder there instead.
  const process = shell?.process ?? folder ?? ""
  const { ref, handleRef, isDragSource } = useSortable({
    id: terminal.id,
    index,
    disabled: editing,
    transition: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  })
  // Right after the program: `!` where it can't go on without the person, `?` where it asks.
  const needMark = need && (
    <span aria-hidden className="terminal-tab-need shrink-0" data-need={need}>
      {need === "unblock" ? "!" : "?"}
    </span>
  )
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
              className={`terminal-glyph inline-block w-[1ch] shrink-0 text-center${waits ? " terminal-tab-wait" : ""}`}
              {...(waits && shell
                ? {
                    "data-wait": waits.jobs.length > 0 ? "job" : "wake",
                    "data-wake-fill": wakeFill(shell),
                  }
                : {})}
            />
            {phase === "starting" ? (
              <span className="terminal-tab-starting truncate italic">starting…</span>
            ) : phase === "done" ? (
              // How its turn ended is its glyph's (tabs.css), in words its description's;
              // beside its program, how long ago, set apart by colour alone, as the line
              // fits "claude" and "now" but no dot between.
              <>
                <span className="terminal-tab-process truncate">{process}</span>
                {needMark}
                {age && <span className="terminal-tab-age shrink-0">{age}</span>}
              </>
            ) : (
              <>
                <span className="terminal-tab-process truncate">{process}</span>
                {needMark}
                {/* Paused, when its usage limit resets, in the age's place. */}
                {resets !== undefined && (
                  <span className="terminal-tab-age shrink-0">{clockTime(resets)}</span>
                )}
                {marks && <SubagentLine marks={marks} />}
              </>
            )}
            {/* After the program, so the program comes first; where a pointer hovers it
                waits in the slot Hide and Rename slide into (tabs.css). Only on a terminal
                agents name by its handle (core/terminals/handle.ts). */}
            <HandleChip
              handle={shell && showsHandle(shell) ? shell.handle : undefined}
              className="handle-plain terminal-tab-handle"
            />
          </>
        }
        {...((marks || waits || passed) && !editing
          ? {
              below: (
                <>
                  {marks && <SubagentBranches marks={marks} />}
                  <Suspense fallback={null}>
                    {waits && shell && <WaitingBranches terminal={shell} waiting={waits} />}
                    {passed && <WakePassed time={passed} />}
                  </Suspense>
                </>
              ),
            }
          : {})}
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
        {...(need ? { "data-terminal-need": need } : {})}
        {...(brightened ? { "data-terminal-unread": true } : {})}
        {...(waits ? { "data-terminal-wait": waits.jobs.length > 0 ? "job" : "wake" } : {})}
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
              ) : isProjectWindow(terminal) ? null : (
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
