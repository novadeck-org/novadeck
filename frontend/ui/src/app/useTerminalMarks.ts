import { noInbox, type Inbox, type InboxItem, type TerminalAt } from "@novadeck/core/inbox"
import { useEffect, useState } from "react"

import { inboxMarks, type InboxMarks } from "../terminals/inbox-marks"
import { useStoreSelector } from "./controller/useStoreSelector"

const sameItems = (a: readonly InboxItem[], b: readonly InboxItem[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index])

const none: readonly InboxItem[] = []

// Follows the raw Inbox for one terminal: it re-renders only when that terminal's own items
// change, and again when one of its limits resets (which makes it an Unblock).
export const useTerminalMarks = (inbox: Inbox | undefined, at: TerminalAt): InboxMarks => {
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
  // The time the limits are judged by, moved on once the next one resets.
  const [now, setNow] = useState(() => Date.now())
  const resetsAt = items
    .flatMap((item) =>
      item.kind === "trouble" && item.trouble.type === "limit" ? [item.trouble.resetsAt] : [],
    )
    .find((each) => each > now)
  useEffect(() => {
    if (resetsAt === undefined) return undefined
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, resetsAt - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [resetsAt])
  return inboxMarks(items, at, now)
}
