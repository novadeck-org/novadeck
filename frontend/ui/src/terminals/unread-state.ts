import type { InboxTurn } from "@novadeck/core/inbox"

// Terminals whose agent ended a turn the person hasn't read, by the session context
// (`${projectId}/${workspaceSessionId}`) that holds them, each with how its newest unread
// turn ended: `unread` on its own (the tab brightens its program), or `failed` on an error.
// Neither is a done report, which comes from the Inbox. The backend stores the rows; this is
// their mirror for the marks (see `watchUnreadTurns`).
export type UnreadEnd = "unread" | "failed"
export type Unread = Readonly<Record<string, Readonly<Record<string, UnreadEnd>>>>

// The terminal the person is looking at: the selected one of the session on screen while
// the page has focus; null while it has none.
export type Viewing = { readonly context: string; readonly id: string } | null

export const noUnread: Unread = {}

// How the terminal's unread turn ended, or undefined when none waits.
export const unreadEnd = (unread: Unread, context: string, id: string): UnreadEnd | undefined =>
  unread[context]?.[id]

// The session context of a stored turn.
export const turnContext = (turn: Pick<InboxTurn, "projectId" | "workspaceSessionId">): string =>
  `${turn.projectId}/${turn.workspaceSessionId}`

// The marks the stored rows make: each terminal's newest row's outcome, the later of two
// rows with the same `at` winning.
export const unreadOfTurns = (turns: readonly InboxTurn[]): Unread => {
  const newest = new Map<string, InboxTurn>()
  for (const turn of turns) {
    const key = `${turnContext(turn)}/${turn.terminalId}`
    const known = newest.get(key)
    if (!known || turn.at >= known.at) newest.set(key, turn)
  }
  const unread: Record<string, Record<string, UnreadEnd>> = {}
  for (const turn of newest.values())
    (unread[turnContext(turn)] ??= {})[turn.terminalId] =
      turn.outcome === "failed" ? "failed" : "unread"
  return unread
}

// Whether two marks say the same.
export const sameUnread = (a: Unread, b: Unread): boolean => {
  const contexts = Object.keys(a)
  if (contexts.length !== Object.keys(b).length) return false
  return contexts.every((context) => {
    const left = a[context]!
    const right = b[context]
    if (!right || Object.keys(left).length !== Object.keys(right).length) return false
    return Object.entries(left).every(([id, end]) => right[id] === end)
  })
}
