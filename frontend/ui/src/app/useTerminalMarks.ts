import { nextLimitReset, noInbox, type Inbox, type InboxRow } from "@novadeck/core/inbox"
import { inboxMarks } from "@novadeck/core/inbox/marks"
import type { InboxMarks } from "@novadeck/core/terminals/ending"
import type { TerminalKey } from "@novadeck/core/types"
import { useEffect, useState } from "react"

import { useStoreSelector } from "./controller/useStoreSelector"
import { sameItems } from "./selectors"

// The time something is judged by, moved on once `nextChange` of it passes though nothing
// else changes, so what is judged by it is judged again then; `nextChange` is asked again
// with each time, for the change after. Undefined waits on nothing.
export const useClock = (nextChange: (now: number) => number | undefined): number => {
  const [now, setNow] = useState(() => Date.now())
  const at = nextChange(now)
  useEffect(() => {
    if (at === undefined) return undefined
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [at])
  return now
}

// The time the limits among `rows` are judged by, moved on once the next one resets (which
// makes its terminal an Unblock) though nothing else changes.
export const useLimitClock = (rows: readonly InboxRow[]): number =>
  useClock((now) => nextLimitReset(rows, now))

const none: readonly InboxRow[] = []

// Follows the raw Inbox for one terminal: it re-renders only when that terminal's own items
// change, and again when one of its limits resets (which makes it an Unblock).
export const useTerminalMarks = (inbox: Inbox | undefined, at: TerminalKey): InboxMarks => {
  const { projectId, workspaceSessionId, terminalId } = at
  const items = useStoreSelector(
    (inbox ?? noInbox).state,
    (state) => {
      const mine = state.items.filter(
        (item) =>
          item.source.terminalId === terminalId &&
          item.source.projectId === projectId &&
          item.source.workspaceSessionId === workspaceSessionId,
      )
      return mine.length === 0 ? none : mine
    },
    sameItems,
  )
  const now = useLimitClock(items)
  return inboxMarks(items, at, now)
}
