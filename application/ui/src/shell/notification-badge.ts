import { terminalAsks } from "../model/terminal-ending"
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
