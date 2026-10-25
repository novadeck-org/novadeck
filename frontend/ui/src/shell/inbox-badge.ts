import { inboxType, urgency, type InboxItem } from "@novadeck/core/inbox"

import { needing } from "../inbox/inbox-state"
import { toneOf } from "../inbox/inbox-text"
import type { ProjectStatus } from "../projects/project-status"

// What the rail's and the Zen dock's bell shows while something in the Inbox waits on the
// person: a dot, toned as the switcher's status marks are by the most pressing of it. How many
// wait is in the bell's name and tooltip, and in the Inbox's header.
export type BellBadge = {
  // How many wait.
  readonly count: number
  // When the newest of what waits began, which the dot rings for (see BellDot).
  readonly latest: number
  // The accessible name of the bell, e.g. "Inbox, 3 waiting".
  readonly label: string
  // The status whose tone the badge takes; the parent's `data-project-status`.
  readonly status: ProjectStatus
}

// The Inbox's badge, undefined while nothing waits: what isn't an update, toned by the most
// pressing of it: trouble that stopped an agent as a failure, an ask as a question, anything
// else as needing attention.
export const inboxBadge = (items: readonly InboxItem[]): BellBadge | undefined => {
  const waiting = needing(items)
  if (waiting.length === 0) return undefined
  const first = waiting.reduce((a, b) => (urgency(b) < urgency(a) ? b : a))
  const type = inboxType(first)
  return {
    count: waiting.length,
    latest: Math.max(...waiting.map((item) => item.at)),
    label: `Inbox, ${waiting.length} waiting`,
    status:
      type === "trouble" && toneOf(first) === "urgent"
        ? "failed"
        : type === "ask"
          ? "question"
          : "attention",
  }
}
