import type { InboxRow } from "@novadeck/core/inbox"

import { needing } from "../inbox/inbox-state"

// What the rail's and the Zen dock's bell shows while something in the Inbox waits on the
// person: the attention dot (attention-dot.css). How many wait is in the bell's name and
// tooltip, and in the Inbox's header.
export type InboxBadge = {
  // How many wait.
  readonly count: number
  // The accessible name of the bell, e.g. "Inbox, 3 waiting".
  readonly label: string
}

// The Inbox's badge, undefined while nothing waits: what isn't an update.
export const inboxBadge = (rows: readonly InboxRow[]): InboxBadge | undefined => {
  const waiting = needing(rows)
  if (waiting.length === 0) return undefined
  return { count: waiting.length, label: `Inbox, ${waiting.length} waiting` }
}
