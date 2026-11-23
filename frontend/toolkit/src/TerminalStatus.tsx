import { useState } from "react"

import { Tooltip } from "./Tooltip"

// What a terminal surface lays over its output, whichever backend draws it: the notice
// while typing is paused, and the bar that says how the shell ended.

// How a shell ended, as `terminalEnding` in core/terminals/ending words it.
export type TerminalEndingView = {
  readonly tone: "danger" | "warning"
  readonly status: string
  readonly reason: string | null
}

const endingLine = ({ status, reason }: TerminalEndingView): string =>
  reason ? `${status} · ${reason}` : status

// Why typing is paused, set in capitals by CSS so assistive technology reads words.
export const TerminalNotice = ({ notice }: { readonly notice: string }): React.JSX.Element => (
  <span className="terminal-notice px-3.5 py-2 text-control font-bold">{notice}</span>
)

// Over the whole surface while typing is paused: the output dims under the notice.
export const TerminalLock = ({ notice }: { readonly notice: string }): React.JSX.Element => (
  <div
    role="status"
    className="terminal-lock pointer-events-none absolute inset-0 flex items-center justify-center"
  >
    <TerminalNotice notice={notice} />
  </div>
)

// Over the whole surface while files dragged over it would go in as they are dropped: what the
// drop does, in a notice, inside an outline.
export const TerminalDrop = ({ notice }: { readonly notice: string }): React.JSX.Element => (
  <div
    data-file-drop
    className="terminal-drop pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-3"
  >
    <TerminalNotice notice={notice} />
  </div>
)

// What dropping `count` files on a terminal does (0: the browser didn't say how many).
export const terminalDropNotice = (count: number): string =>
  count > 1
    ? `Drop to paste ${count} paths`
    : count === 1
      ? "Drop to paste its path"
      : "Drop to paste the paths"

// How the shell ended, along the surface's bottom edge, with the restart Enter also
// asks for. In Canvas its right end follows the resize grip's scale so the button stays
// clear of it (terminal-status.css). Restart waits while typing is paused, as a restart
// then could not reach the shell. It keeps the last ending on screen while it slides
// away; the surface announces it.
export const TerminalEndingBar = ({
  ending,
  paused,
  onRestart,
}: {
  readonly ending: TerminalEndingView | null
  readonly paused: boolean
  readonly onRestart: () => void
}): React.JSX.Element => {
  const [shown, setShown] = useState(ending)
  const text = shown ? endingLine(shown) : ""
  // Each render derives a fresh ending; only a different one replaces the shown one.
  if (ending && (ending.tone !== shown?.tone || endingLine(ending) !== text)) setShown(ending)
  return (
    <div
      className={`terminal-ending absolute inset-x-0 bottom-0 flex h-7 items-center justify-between gap-3 text-control ${ending ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-full opacity-0"}`}
      inert={!ending}
      data-terminal-ending={ending?.tone}
    >
      <Tooltip content={text} disabled={!text}>
        <span className="min-w-0 truncate">
          <span className="font-medium">{shown?.status}</span>
          {shown?.reason && <span className="terminal-ending-reason"> · {shown.reason}</span>}
        </span>
      </Tooltip>
      {shown && (
        <button
          type="button"
          aria-disabled={paused || undefined}
          className="terminal-restart flex shrink-0 cursor-pointer items-center gap-1.5 px-1.5 py-0.5 font-medium"
          onClick={() => {
            if (!paused) onRestart()
          }}
        >
          Restart
          <kbd aria-hidden className="min-h-4 px-1 text-label">
            ↵
          </kbd>
        </button>
      )}
    </div>
  )
}

// Along the top of a terminal this window only observes, because another window or browser
// controls it: who is typing, and the button that takes the keyboard. It is quiet, in the flow
// above the output, so the screen scales into what is left. `busy` is the answer to a take
// that was refused because the controller was typing: the same words, kept in sight.
export const TerminalControlStrip = ({
  busy,
  onTake,
}: {
  readonly busy: boolean
  readonly onTake: () => void
}): React.JSX.Element => (
  <div
    className="terminal-control flex h-7 shrink-0 items-center justify-between gap-3 px-3 text-control"
    data-terminal-control={busy ? "busy" : "observing"}
  >
    <span className="min-w-0 truncate font-medium">Typing in another window</span>
    <button
      type="button"
      className="terminal-take flex shrink-0 cursor-pointer items-center gap-1.5 px-1.5 py-0.5 font-medium"
      onClick={onTake}
    >
      Take over
    </button>
  </div>
)
