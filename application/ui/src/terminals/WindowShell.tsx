import {
  Minimize2,
  Scaling,
  Shrink,
  FoldHorizontal,
  UnfoldHorizontal,
  ArrowUpRight,
  Minus,
  Plus,
  X,
} from "lucide-react"
import { useRef, type ReactNode } from "react"

import { workspaceShortcutBindings } from "../interaction/shortcuts"
import { subagentsBadge, subagentsDetail } from "../model/agent-subagents"
import { nextReset, usageBadge, usageDetail } from "../model/agent-usage"
import { attentionText, terminalPhase } from "../model/terminal-ending"
import type { TerminalMetadata, WindowedView } from "../model/types"
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
}

const headerActionClasses =
  "icon-button [&>svg]:opacity-25 [&>svg]:transition-opacity [&>svg]:duration-(--motion-feedback) [&>svg]:ease-interface hover:[&>svg]:opacity-100"

export type WindowShellProps = {
  terminal: TerminalMetadata
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
  compact?: boolean
  active?: boolean
  fresh?: boolean
  rename: TerminalRename | null
  onBeginRename: () => void
  onRenameDraft: (value: string) => void
  onRenameSave: () => void
  onRenameCancel: () => void
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
  compact = false,
  active = false,
  fresh = false,
  rename,
  onBeginRename,
  onRenameDraft,
  onRenameSave,
  onRenameCancel,
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
  const focusHint = active ? ` · ${workspaceShortcutBindings().focus.display.join(" ")}` : ""
  const headerPress = useRef<{ x: number; y: number; time: number; rename: boolean } | null>(null)
  const headerTap = useRef<{ x: number; y: number; time: number; rename: boolean } | null>(null)
  const ignoreDoubleClickUntil = useRef(0)
  const renaming = Boolean(rename)
  useRenderAt(nextReset(terminal))
  const usage = usageBadge(terminal)
  const subagents = subagentsBadge(terminal)
  const planning = terminal.state === "running" && terminal.agent?.planning === true
  const headerDoubleAction = onFlyTo
  return (
    <section
      className={`terminal-window flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-panel border border-line bg-paper shadow-panel transition-[border-color] duration-(--motion-state) ease-interface ${compact ? "terminal-compact" : "terminal-focused"}`}
      aria-label={`${terminal.name} terminal`}
      data-terminal={terminal.id}
      data-terminal-phase={terminalPhase(terminal)}
      {...(attentionText(terminal) ? { "aria-description": attentionText(terminal) } : {})}
      data-process-window={processWindow}
      data-new={fresh}
    >
      <div className="terminal-heading relative shrink-0">
        <header
          className="terminal-header flex h-12 shrink-0 touch-manipulation select-none flex-nowrap items-center justify-between gap-3 border-b border-line bg-paper px-4 text-xs whitespace-nowrap [&_svg]:shrink-0 [&_svg]:text-muted"
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
          <div className="terminal-title flex min-w-0 items-center gap-2.5 [&>h1]:truncate [&>h1]:font-medium [&>h2]:truncate [&>h2]:font-medium">
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
                  className="w-full min-w-0 border-0 bg-transparent p-0 text-xs font-medium text-ink outline-none nodrag nopan"
                />
              )}
            </>
          </div>
          {(planning || usage || subagents) && !compact && (
            // Whether the agent plans, its subagents, context and busiest rate limit, in
            // full on hover. Only a focused window has room beside its name; a compact one
            // leaves them to its tab's tooltip.
            <span className="ml-auto flex min-w-0 items-center gap-2 overflow-hidden font-mono text-[10px] text-muted">
              {planning && (
                <span
                  className="terminal-planning shrink-0"
                  title="Planning, not changing anything yet"
                >
                  planning
                </span>
              )}
              {subagents && (
                <span className="terminal-subagents shrink-0" title={subagentsDetail(terminal)}>
                  {subagents}
                </span>
              )}
              {usage && (
                <span className="terminal-usage min-w-0 truncate" title={usageDetail(terminal)}>
                  {usage}
                </span>
              )}
            </span>
          )}
          <span className="terminal-actions flex shrink-0 items-center gap-1">
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
      </div>
      {children}
    </section>
  )
}
