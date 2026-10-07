import {
  Minimize2,
  Scaling,
  Shrink,
  FoldHorizontal,
  UnfoldHorizontal,
  ArrowUpRight,
  Mic,
  Minus,
  Plus,
  X,
} from "lucide-react"
import { useRef, type ReactNode } from "react"

import { shortcutBindings } from "../interaction/shortcuts"
import { subagentsBadge, subagentsDetail } from "../model/agent-subagents"
import { nextReset, usageBadge, usageDetail } from "../model/agent-usage"
import { isWindow } from "../model/roster"
import { attentionText, doneText, terminalPhase, unheardText } from "../model/terminal-ending"
import type { Tile, WindowedView } from "../model/types"
import { ContextMenu, type ContextMenuItem } from "../ui-toolkit/ContextMenu"
import { Tooltip } from "../ui-toolkit/Tooltip"
import { TerminalRenameInput, type TerminalRename } from "./TerminalRenameInput"
import { useRenderAt } from "./use-render-at"

export type MinimizeControls = {
  minimized: boolean
  clipContent?: boolean
  onToggle: () => void
}

// What a layout contributes to each terminal it places.
export type TerminalLayoutControls = {
  readonly minimize?: MinimizeControls
  readonly onFlyTo?: () => void
  readonly onResizePreset?: (button: HTMLButtonElement) => void
  // Frames the terminal together with content hanging past its right edge.
  readonly onReveal?: (extent: { readonly right: number; readonly height: number }) => void
}

const headerActionClasses = "icon-button dim"

// The mic button an agent's header offers while voice input is ready: click to start
// recording into the terminal, and again to send.
export type DictationControls = {
  readonly recording: boolean
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
  resizeView?: WindowedView
  large?: boolean
  windowed?: { destination: string; onOpen: () => void }
  onClose?: () => void
  minimize?: MinimizeControls
  dictation?: DictationControls
  compact?: boolean
  active?: boolean
  fresh?: boolean
  // Its agent finished while the person looked elsewhere, on its own or on an error: the
  // window says so until they look.
  unread?: "done" | "failed" | undefined
  rename: TerminalRename | null
  onBeginRename: () => void
  onRenameDraft: (value: string) => void
  onRenameSave: () => void
  onRenameCancel: () => void
  // The window's own actions, on its header's right-click, as on its sidebar tab's.
  menu?: ContextMenuItem[]
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
  resizeView = "canvas",
  large = false,
  onClose,
  windowed,
  minimize,
  dictation,
  compact = false,
  active = false,
  fresh = false,
  unread,
  rename,
  onBeginRename,
  onRenameDraft,
  onRenameSave,
  onRenameCancel,
  menu,
}: WindowShellProps): React.JSX.Element => {
  const resizeLabel = large
    ? resizeView === "grid"
      ? "Restore width"
      : "Make compact"
    : resizeView === "grid"
      ? "Make full width"
      : "Enlarge terminal"
  const ResizeIcon =
    resizeView === "grid" ? (large ? FoldHorizontal : UnfoldHorizontal) : large ? Shrink : Scaling
  const Heading = compact ? "h2" : "h1"
  const focusHint = active ? ` · ${shortcutBindings().focus.display.join(" ")}` : ""
  const headerPress = useRef<{ x: number; y: number; time: number; rename: boolean } | null>(null)
  const headerTap = useRef<{ x: number; y: number; time: number; rename: boolean } | null>(null)
  const ignoreDoubleClickUntil = useRef(0)
  const renaming = Boolean(rename)
  const shell = isWindow(terminal) ? undefined : terminal
  useRenderAt(shell && nextReset(shell))
  const usage = shell && usageBadge(shell)
  const subagents = shell && subagentsBadge(shell)
  const planning = shell?.state === "running" && shell.agent?.planning === true
  const phase = shell ? terminalPhase(shell, unread !== undefined) : "idle"
  const failed = unread === "failed"
  // What the agent waits on the person for, that Novadeck can't hear from it, or that it
  // finished with its reply unread.
  const note =
    shell &&
    (attentionText(shell) ??
      unheardText(shell) ??
      (phase === "done" ? doneText(failed) : undefined))
  const headerDoubleAction = onFlyTo
  const header = (
    <header
      className="terminal-header flex shrink-0 touch-manipulation select-none flex-nowrap items-center justify-between whitespace-nowrap"
      onDoubleClick={(event) => {
        if (
          performance.now() < ignoreDoubleClickUntil.current ||
          (event.target as Element).closest("button, input")
        )
          return
        if ((event.target as Element).closest("[data-terminal-name]")) {
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
          rename: Boolean((event.target as Element).closest("[data-terminal-name]")),
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
      <div
        className={`terminal-title flex min-w-0 items-center [&>h1]:truncate [&>h2]:truncate ${phase === "done" ? "[&>h1]:font-bold [&>h2]:font-bold" : "[&>h1]:font-medium [&>h2]:font-medium"}`}
      >
        {switcher ? (
          <Tooltip content="Switch terminal">
            <button
              className={`${headerActionClasses} nodrag nopan`}
              aria-label="Switch terminal"
              onClick={(event) => {
                event.stopPropagation()
                switcher.onOpen(event.currentTarget)
              }}
            >
              {icon}
            </button>
          </Tooltip>
        ) : (
          icon
        )}
        <>
          <Heading hidden={renaming} data-terminal-name="">
            {terminal.name}
          </Heading>
          {rename && (
            <TerminalRenameInput
              id={terminal.id}
              name={terminal.name}
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
      {phase === "done" && (
        // Said in full as the window's description; a compact window keeps its name.
        <span className="terminal-done ml-auto shrink-0 text-caption" aria-hidden>
          {compact ? (failed ? "Error" : "Done") : doneText(failed)}
        </span>
      )}
      {(planning || usage || subagents) && !compact && (
        // Whether the agent plans, its subagents, context and busiest rate limit, in
        // full on hover. Only a focused window has room beside its name; a compact one
        // leaves them to its tab's tooltip.
        <span className="terminal-metadata ml-auto flex min-w-0 items-center gap-2 overflow-hidden text-caption">
          {planning && (
            <Tooltip content="Planning, not changing anything yet">
              <span className="terminal-planning shrink-0">planning</span>
            </Tooltip>
          )}
          {shell && subagents && (
            <Tooltip content={subagentsDetail(shell)}>
              <span className="terminal-subagents shrink-0">{subagents}</span>
            </Tooltip>
          )}
          {shell && usage && (
            <Tooltip content={usageDetail(shell)}>
              <span className="terminal-usage min-w-0 truncate">{usage}</span>
            </Tooltip>
          )}
        </span>
      )}
      <span className="terminal-actions flex shrink-0 items-center">
        {dictation && (
          <Tooltip
            content={
              dictation.recording
                ? "Stop and send"
                : `Dictate · hold ${shortcutBindings().voice.display.join(" ")}`
            }
          >
            <button
              className={`${headerActionClasses} dictation-action nodrag nopan ${dictation.recording ? "dictation-active" : ""}`}
              aria-label={`Dictate into ${terminal.name}`}
              aria-pressed={dictation.recording}
              onClick={(event) => {
                event.stopPropagation()
                dictation.onToggle()
              }}
            >
              <Mic size={12} />
            </button>
          </Tooltip>
        )}
        {minimize && (
          <Tooltip content={minimize.minimized ? "Restore" : "Minimize"}>
            <button
              className={`${headerActionClasses} terminal-view-action nodrag nopan`}
              aria-label={`${minimize.minimized ? "Restore" : "Minimize"} ${terminal.name}`}
              aria-expanded={!minimize.minimized}
              onClick={(event) => {
                event.stopPropagation()
                minimize.onToggle()
              }}
            >
              {minimize.minimized ? <Plus size={12} /> : <Minus size={12} />}
            </button>
          </Tooltip>
        )}
        {onResizePreset && (
          <Tooltip
            content={
              large
                ? resizeView === "grid"
                  ? "Restore width"
                  : "Compact"
                : resizeView === "grid"
                  ? "Full width"
                  : "Enlarge"
            }
          >
            <button
              className={`${headerActionClasses} terminal-view-action nodrag nopan`}
              aria-label={`${resizeLabel}: ${terminal.name}`}
              aria-pressed={large}
              onClick={(event) => {
                event.stopPropagation()
                onResizePreset(event.currentTarget)
              }}
            >
              <ResizeIcon size={14} />
            </button>
          </Tooltip>
        )}
        {onFocus && (
          <Tooltip content={`Focus${focusHint}`}>
            <button
              className={`${headerActionClasses} terminal-view-action nodrag nopan`}
              aria-label={`Focus ${terminal.name}`}
              onClick={(event) => {
                event.stopPropagation()
                onFocus()
              }}
            >
              <ArrowUpRight size={12} />
            </button>
          </Tooltip>
        )}
        {windowed && (
          <Tooltip content={`${windowed.destination}${focusHint}`}>
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
              aria-label={`Close ${terminal.name}`}
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
      aria-label={`${terminal.name} terminal`}
      data-terminal={terminal.id}
      data-terminal-phase={phase}
      {...(phase === "done" && failed ? { "data-terminal-failed": true } : {})}
      {...(note ? { "aria-description": note } : {})}
      data-process-window={processWindow}
      data-new={fresh}
    >
      <div className="terminal-heading relative shrink-0">
        {menu ? (
          <ContextMenu label={`${terminal.name} actions`} items={menu} trigger={header} />
        ) : (
          header
        )}
      </div>
      {children}
    </section>
  )
}
