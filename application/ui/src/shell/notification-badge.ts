import { inboxType, urgency, type InboxItem } from "#core/inbox"
import { terminalAsks } from "#core/terminal-ending"

import { needing } from "../inbox/inbox-state"
import { toneOf } from "../inbox/inbox-text"
import type { Notification } from "../notifications/notifications"
import { askStatus, type ProjectStatus } from "../projects/project-status"

// What the rail's and the Zen dock's bell shows while something asks for the person: a
// count, toned as the switcher's status marks are by the most pressing kind.
export type BellBadge = {
  // The count as the badge prints it, capped at "9+".
  readonly text: string
  // The accessible name of the bell, e.g. "Notifications, 3 waiting".
  readonly label: string
  // The status whose tone the badge takes; the parent's `data-project-status`.
  readonly status: ProjectStatus
}

// Undefined while nothing asks, so the bell carries no badge. The list comes most
// pressing first, but this does not rely on it.
export const notificationBadge = (list: readonly Notification[]): BellBadge | undefined => {
  if (list.length === 0) return undefined
  const kind = terminalAsks.find((item) => list.some((entry) => entry.kind === item))!
  return {
    text: list.length > 9 ? "9+" : String(list.length),
    label: `Notifications, ${list.length} waiting`,
    status: askStatus[kind],
  }
}

// The Inbox's badge: what isn't an update, toned by the most pressing of it: trouble that
// stopped an agent as a failure, an ask as a question, anything else as needing attention.
export const inboxBadge = (items: readonly InboxItem[]): BellBadge | undefined => {
  const waiting = needing(items)
  if (waiting.length === 0) return undefined
  const first = waiting.reduce((a, b) => (urgency(b) < urgency(a) ? b : a))
  const type = inboxType(first)
  return {
    text: waiting.length > 9 ? "9+" : String(waiting.length),
    label: `Inbox, ${waiting.length} waiting`,
    status:
      type === "trouble" && toneOf(first) === "urgent"
        ? "failed"
        : type === "ask"
          ? "question"
          : "attention",
  }
}
