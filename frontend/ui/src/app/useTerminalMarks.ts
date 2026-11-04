import { nextLimitReset, noInbox, type Inbox, type InboxRow } from "@novadeck/core/inbox"
import { inboxMarks } from "@novadeck/core/inbox/marks"
import type { InboxMarks } from "@novadeck/core/terminals/ending"
import type { TerminalKey } from "@novadeck/core/types"
import { useEffect, useState } from "react"

import { useStoreSelector } from "./controller/useStoreSelector"
import { sameItems } from "./selectors"

// Moves a clock (`setNow`, a `useState` setter) on to the time once `at` passes though
// nothing else changes, so what is judged by it is judged again then. Undefined waits on
// nothing. The caller works `at` out from the clock's time, so it is asked again with each.
export const useMoveOn = (at: number | undefined, setNow: (now: number) => void): void => {
  useEffect(() => {
    if (at === undefined) return undefined
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [at, setNow])
}

// The time the limits among `rows` are judged by, moved on once the next one resets (which
// makes its terminal an Unblock) though nothing else changes.
export const useLimitClock = (rows: readonly InboxRow[]): number => {
  const [now, setNow] = useState(() => Date.now())
  useMoveOn(nextLimitReset(rows, now), setNow)
  return now
}

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
