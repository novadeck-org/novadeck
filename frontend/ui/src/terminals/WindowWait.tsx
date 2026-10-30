import { clockTime, waitingLine, wakeFill } from "@novadeck/core/agents/waiting"
import { minutesWaited, wakeIn } from "@novadeck/core/agents/waiting-clock"
import type { TerminalMetadata } from "@novadeck/core/types"

import { useSecond } from "./use-second"

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
    <span aria-hidden className="window-wait nodrag nopan flex items-center gap-1.5">
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
        <span className="truncate tabular-nums">
          wakes at {clockTime(line.at)} · {wakeIn(line.at)}
        </span>
      )}
    </span>
  )
}
