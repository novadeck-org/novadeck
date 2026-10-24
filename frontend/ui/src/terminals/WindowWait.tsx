import {
  clockTime,
  countdown,
  minutesWaited,
  waitingLine,
  wakeFill,
} from "@novadeck/core/agent-waiting"
import type { TerminalMetadata } from "@novadeck/core/types"
import { useEffect, useState } from "react"

// Renders the component again every second while `ticking`, for a wake-up's countdown.
const useSecond = (ticking: boolean): void => {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!ticking) return undefined
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000)
    return () => clearInterval(timer)
  }, [ticking])
}

// What a waiting agent waits on, in its window's bar after the name: how long first, so
// the cut keeps it, then the agent's own description cut to fit with an ellipsis ("4m ·
// Watch CI checks for PR #436"); for a wake-up its time and the time left, counting down
// ("wakes at 14:32 · in 8:14"). The minutes move on when the window renders again
// (WindowShell.tsx); the window's description says it in words for assistive technology.
export const WindowWait = ({
  terminal,
}: {
  terminal: TerminalMetadata
}): React.JSX.Element | null => {
  const line = waitingLine(terminal)
  useSecond(line?.kind === "wake")
  if (!line) return null
  return (
    <span
      aria-hidden
      className="window-wait nodrag nopan flex min-w-0 items-center gap-1.5"
      data-wait={line.kind}
    >
      <span
        className="terminal-tab-wait inline-block w-[1ch] shrink-0 text-center"
        data-wait={line.kind}
        {...(line.kind === "wake" ? { "data-wake-fill": wakeFill(terminal) } : {})}
      />
      {line.kind === "job" ? (
        <>
          <span className="shrink-0">{minutesWaited(line.since)}</span>
          <span className="shrink-0">·</span>
          <strong className="truncate font-medium">{line.label}</strong>
        </>
      ) : (
        <>
          <span className="shrink-0">wakes at {clockTime(line.at)}</span>
          <span className="shrink-0">·</span>
          <span className="shrink-0 tabular-nums">in {countdown(line.at)}</span>
        </>
      )}
    </span>
  )
}
