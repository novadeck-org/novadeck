import { clockTime, nextWaitingChange, waitingText } from "@novadeck/core/agent-waiting"
import { handleText, terminalLabel } from "@novadeck/core/handle"
import { isWindow } from "@novadeck/core/roster"
import {
  doneText,
  needText,
  pausedText,
  pausedUntil,
  terminalNeedMark,
  terminalPhase,
  unheardText,
} from "@novadeck/core/terminal-ending"
import type { Tile } from "@novadeck/core/types"
import { ContextMenu, type ContextMenuItem } from "@novadeck/toolkit/ContextMenu"
import { HandleChip } from "@novadeck/toolkit/HandleChip"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { Minimize2, FoldHorizontal, UnfoldHorizontal, Maximize2, Mic, X } from "lucide-react"
import { lazy, Suspense, useRef, type ReactNode } from "react"

import { shortcutBindings } from "../interaction/shortcuts"
import { isProjectWindow } from "./project-window"
import { TerminalRenameInput, type TerminalRename } from "./TerminalRenameInput"
import { useRenderAt } from "./use-render-at"

// What a layout contributes to each terminal it places.
export type TerminalLayoutControls = {
  readonly onFlyTo?: () => void
  readonly onResizePreset?: (button: HTMLButtonElement) => void
  // Frames the terminal together with content hanging past its right edge.
  readonly onReveal?: (extent: { readonly right: number; readonly height: number }) => void
  // False while the layout holds the terminal out of the person's sight. Absent means in sight.
  readonly onScreen?: boolean
}

// The bar's words on what a waiting agent waits on load when one does.
const WindowWait = lazy(() =>
  import("./WindowWait").then((module) => ({ default: module.WindowWait })),
)

const headerActionClasses = "icon-button dim"

// The mic button an agent's header offers while the person wants voice input: once it is
// ready, click to start recording into the terminal, and again to send; before, the click
// leads to its install.
export type DictationControls = {
  readonly recording: boolean
  // False until voice input is installed and on; absent means ready.
  readonly ready?: boolean
  readonly onToggle: () => void
}

export type WindowShellProps = {
  // A terminal, or a window undocked from a companion, which runs nothing.
  terminal: Tile
  children?: ReactNode
  // The header's icon, which also opens the terminal switcher.
  icon: ReactNode
  // Names the program the window presents as, for its styles and tests.
  processWindow?: string
  onFocus?: () => void
  switcher?: { onOpen: (button: HTMLButtonElement) => void }
  onFlyTo?: () => void
  onResizePreset?: (button: HTMLButtonElement) => void
  // Grid's width preset: full width, or the width from before.
  large?: boolean
  windowed?: { destination: string; onOpen: () => void }
  onClose?: () => void
  dictation?: DictationControls
  compact?: boolean
  active?: boolean
  fresh?: boolean
  // Its agent ended a turn while the person looked elsewhere, on its own or on an error: a
  // failed one says so until they look.
  unread?: "unread" | "failed" | undefined
  // What the Inbox says it needs of the person (`unblock` or `ask`), the subject of the item
  // behind it, and whether its agent reported its task done, unseen. The agent's live dialog
  // adds its own need.
  need?: "unblock" | "ask" | undefined
  needSubject?: string | undefined
  reported?: boolean
  // The terminal that directs this one's work while it runs, by its handle and name.
  lead?: { handle: string; name: string }
  // The terminals this one directs while it leads: how many, and who in words.
  leads?: { count: number; names: string }
  rename: TerminalRename | null
  onBeginRename: () => void
  onRenameDraft: (value: string) => void
  onRenameSave: () => void
  onRenameCancel: () => void
  // The window's own actions, on its header's right-click, as on its sidebar tab's.
  menu?: ContextMenuItem[]
  // Beside the title, as Murmur's offer chip: it keeps its size while the name truncates.
  titleExtra?: ReactNode
}

// The window every terminal shares, whatever program runs in it.
export const WindowShell = ({
  terminal,
  children,
  icon,
  processWindow,
  onFocus,
  switcher,
  onFlyTo,
  onResizePreset,
  large = false,
  onClose,
  windowed,
  dictation,
  compact = false,
  active = false,
  fresh = false,
  unread,
  need: inboxNeed,
  needSubject,
  reported = false,
  lead,
  leads,
  rename,
  onBeginRename,
  onRenameDraft,
  onRenameSave,
  onRenameCancel,
  menu,
  titleExtra,
}: WindowShellProps): React.JSX.Element => {
  const resizeLabel = large ? "Restore width" : "Make full width"
  const ResizeIcon = large ? FoldHorizontal : UnfoldHorizontal
  const Heading = compact ? "h2" : "h1"
  const focusHint = active ? ` · ${shortcutBindings().focus.display.join(" ")}` : ""
  const headerPress = useRef<{
    x: number
    y: number
    time: number
    rename: boolean
  } | null>(null)
  const headerTap = useRef<{
    x: number
    y: number
    time: number
    rename: boolean
  } | null>(null)
  const ignoreDoubleClickUntil = useRef(0)
  const renaming = Boolean(rename)
  const shell = isWindow(terminal) ? undefined : terminal
  const label = terminalLabel(terminal.name, shell?.handle)
  const failed = unread === "failed"
  const phase = shell ? terminalPhase(shell, reported || failed) : "idle"
  const need = shell && phase !== "ended" ? terminalNeedMark(shell, inboxNeed) : undefined
  useRenderAt(phase === "waiting" && shell ? nextWaitingChange(shell) : undefined)
  const resets = shell && phase === "paused" ? pausedUntil(shell) : undefined
  // What the agent needs of the person, that Novadeck can't hear from it, that it is paused
  // at its limit, what it waits on that wakes it, or that it finished with its reply unread.
  const note =
    shell &&
    [
      needText(shell, need, needSubject),
      unheardText(shell) ??
        pausedText(shell) ??
        (phase === "waiting" ? waitingText(shell) : undefined) ??
        (phase === "done" ? doneText(failed) : undefined),
    ]
      .filter(Boolean)
      .join(", ")
  const headerDoubleAction = onFlyTo
  // The project window is named by its file, so its name is no rename's: a double-click on it
  // is the header's own.
  const nameRenames = !isProjectWindow(terminal)
  const header = (
    <header
      className="terminal-header flex shrink-0 touch-manipulation select-none flex-nowrap items-center justify-between whitespace-nowrap"
      onDoubleClick={(event) => {
        // What a popover in a portal got (Murmur's offer) reaches here through React, but is not
        // the header's.
        if (!event.currentTarget.contains(event.target as Node)) return
        if (
          performance.now() < ignoreDoubleClickUntil.current ||
          (event.target as Element).closest("button, input")
        )
          return
        if (nameRenames && (event.target as Element).closest("[data-terminal-name]")) {
          event.preventDefault()
          event.stopPropagation()
          onBeginRename()
          return
        }
        if (!headerDoubleAction) return
        event.preventDefault()
        event.stopPropagation()
        headerDoubleAction()
      }}
      onPointerDown={(event) => {
        if (!event.currentTarget.contains(event.target as Node)) return
        if (event.pointerType !== "touch") return
        if (!event.isPrimary || (event.target as Element).closest("button, input")) {
          headerPress.current = null
          headerTap.current = null
          return
        }
        headerPress.current = {
          x: event.clientX,
          y: event.clientY,
          time: event.timeStamp,
          rename: nameRenames && Boolean((event.target as Element).closest("[data-terminal-name]")),
        }
      }}
      onPointerMove={(event) => {
        const press = headerPress.current
        if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) {
          headerPress.current = null
          headerTap.current = null
        }
      }}
      onPointerCancel={() => {
        headerPress.current = null
        headerTap.current = null
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.contains(event.target as Node)) return
        if (event.pointerType !== "touch") return
        const press = headerPress.current
        headerPress.current = null
        if (
          !press ||
          event.timeStamp - press.time > 300 ||
          Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8
        ) {
          headerTap.current = null
          return
        }
        const previous = headerTap.current
        headerTap.current = {
          ...press,
          x: event.clientX,
          y: event.clientY,
          time: event.timeStamp,
        }
        if (
          !previous ||
          previous.rename !== press.rename ||
          event.timeStamp - previous.time > 350 ||
          Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > 24
        )
          return
        headerTap.current = null
        if (!press.rename && !headerDoubleAction) return
        ignoreDoubleClickUntil.current = performance.now() + 500
        event.preventDefault()
        event.stopPropagation()
        if (press.rename) onBeginRename()
        else headerDoubleAction?.()
      }}
    >
      <div className="terminal-title flex min-w-0 flex-1 items-center">
        {switcher ? (
          <Tooltip content="Switch terminal">
            <button
              className={`${headerActionClasses} terminal-switch nodrag nopan`}
              aria-label="Switch terminal"
              onClick={(event) => {
                event.stopPropagation()
                switcher.onOpen(event.currentTarget)
              }}
            >
              {icon}
              {/* The sidebar shows every handle, so the header keeps it under the pointer. */}
              {!renaming && shell && (
                <HandleChip handle={shell.handle} className="handle-plain terminal-switch-handle" />
              )}
            </button>
          </Tooltip>
        ) : (
          icon
        )}
        <>
          {/* The name, who leads it and how many it leads share a line; each shows whole
              beside the name or wraps out of sight (window.css), so the name gives way last. */}
          <span
            className={`terminal-title-text [&>h1]:truncate [&>h2]:truncate ${phase === "done" ? "[&>h1]:font-bold [&>h2]:font-bold" : "[&>h1]:font-medium [&>h2]:font-medium"}`}
            hidden={renaming}
          >
            <Heading hidden={renaming} data-terminal-name="">
              {terminal.name}
            </Heading>
            {lead && !renaming && (
              <Tooltip
                content={`Directed by the agent in ${handleText(lead.handle)} · ${lead.name}`}
              >
                <span className="terminal-lead nodrag nopan" data-terminal-lead={lead.handle}>
                  led by {handleText(lead.handle)}
                </span>
              </Tooltip>
            )}
            {leads && !renaming && (
              <Tooltip content={`Directs the agents in ${leads.names}`}>
                <span className="terminal-lead nodrag nopan" data-terminal-leads={leads.count}>
                  leads {leads.count}
                </span>
              </Tooltip>
            )}
          </span>
          {/* Right after the name: `!` where the agent can't go on without the person, `?`
              where it asks. */}
          {!renaming && need && (
            <span aria-hidden className="terminal-need nodrag nopan" data-need={need}>
              {need === "unblock" ? "!" : "?"}
            </span>
          )}
          {!renaming && titleExtra}
          {/* Paused at its usage limit, where the wait's line would be, with the reset. */}
          {!renaming && resets !== undefined && (
            <span aria-hidden className="terminal-paused nodrag nopan">
              ∅ {clockTime(resets)}
            </span>
          )}
          {!renaming && !compact && phase === "waiting" && shell && (
            <Suspense fallback={null}>
              <WindowWait terminal={shell} />
            </Suspense>
          )}
          {rename && (
            <TerminalRenameInput
              id={terminal.id}
              name={terminal.name}
              label={label}
              value={rename.value}
              request={rename.request}
              autoFocus={rename.origin === "header"}
              onChange={onRenameDraft}
              onSave={onRenameSave}
              onCancel={onRenameCancel}
              className="terminal-rename-input w-full min-w-0 text-body leading-4 font-medium nodrag nopan"
            />
          )}
        </>
      </div>
      <span className="terminal-actions flex shrink-0 items-center">
        {dictation && (
          <Tooltip
            content={
              dictation.ready === false
                ? "Dictate · turn on voice input"
                : dictation.recording
                  ? "Stop and send"
                  : `Dictate · hold ${shortcutBindings().voice.display.join(" ")}`
            }
          >
            <button
              className={`${headerActionClasses} dictation-action nodrag nopan ${dictation.recording ? "dictation-active" : ""}`}
              aria-label={
                dictation.ready === false
                  ? `Set up voice input for ${label}`
                  : `Dictate into ${label}`
              }
              aria-pressed={dictation.ready === false ? undefined : dictation.recording}
              onClick={(event) => {
                event.stopPropagation()
                dictation.onToggle()
              }}
            >
              <Mic size={12} />
            </button>
          </Tooltip>
        )}
        {onResizePreset && (
          <Tooltip content={large ? "Restore width" : "Full width"}>
            <button
              className={`${headerActionClasses} terminal-view-action nodrag nopan`}
              aria-label={`${resizeLabel}: ${label}`}
              aria-pressed={large}
              onClick={(event) => {
                event.stopPropagation()
                onResizePreset(event.currentTarget)
              }}
            >
              <ResizeIcon size={12} />
            </button>
          </Tooltip>
        )}
        {onFocus && (
          <Tooltip content={`Focus${focusHint}`}>
            <button
              className={`${headerActionClasses} terminal-view-action nodrag nopan`}
              aria-label={`Focus ${label}`}
              onClick={(event) => {
                event.stopPropagation()
                onFocus()
              }}
            >
              <Maximize2 size={12} />
            </button>
          </Tooltip>
        )}
        {windowed && (
          <Tooltip content={`Open in ${windowed.destination}${focusHint}`}>
            <button
              className={`${headerActionClasses} terminal-view-action`}
              aria-label={`Open in ${windowed.destination}`}
              onClick={windowed.onOpen}
            >
              <Minimize2 size={12} />
            </button>
          </Tooltip>
        )}
        {onClose && (
          <Tooltip content="Close">
            <button
              className={`${headerActionClasses} terminal-close nodrag nopan`}
              aria-label={`Close ${label}`}
              onClick={(event) => {
                event.stopPropagation()
                onClose()
              }}
            >
              <X size={12} />
            </button>
          </Tooltip>
        )}
      </span>
    </header>
  )
  return (
    <section
      className={`terminal-window flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${compact ? "terminal-compact" : "terminal-focused"}`}
      aria-label={`${label} terminal`}
      data-terminal={terminal.id}
      data-terminal-phase={phase}
      {...(phase === "done" && failed ? { "data-terminal-failed": true } : {})}
      {...(need ? { "data-terminal-need": need } : {})}
      {...(note ? { "aria-description": note } : {})}
      data-process-window={processWindow}
      data-new={fresh}
    >
      <div className="terminal-heading relative shrink-0">
        {menu ? <ContextMenu label={`${label} actions`} items={menu} trigger={header} /> : header}
        <span className="terminal-sweep" aria-hidden="true" />
      </div>
      {children}
    </section>
  )
}
