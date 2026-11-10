import type { TerminalMoveResult } from "@novadeck/core/port"
import type { WorkspaceSession } from "@novadeck/core/types"

// Where the person moves a terminal: a session of its project by id, or a new one.
export type MoveTarget = { readonly sessionId: string } | { readonly fresh: true }

// The terminal on its way to another session, while the person picks where: from its menu's
// "All sessions…", in the Sessions panel, or by dragging its tab there. `over` is what a drag
// holds over: a session, the new session's button, or nothing yet.
export type MovePick = {
  readonly context: string
  readonly terminalId: string
  readonly via: "menu" | "drag"
  readonly over: MoveTarget | null
}

// A teammate's move waiting for the person to say whether it goes alone, out of its lead's
// team, or with that whole team.
export type MoveAsk = {
  readonly context: string
  readonly terminalId: string
  readonly to: MoveTarget
}

// What the toast after a move tells: what moved where, still running, a handle that changed
// there and the lead it left; and what takes it back. A move the backend refused says why.
export type MoveNotice = {
  // Each move's own, so one told again replaces its toast rather than stacking.
  readonly id: string
  readonly projectId: string
  readonly terminalId: string
  readonly name: string
  // The session it went to, which `fresh` was made for it, and the one it came from.
  readonly session: { readonly id: string; readonly name: string }
  readonly fresh?: boolean
  readonly from: string
} & (
  | { readonly result: TerminalMoveResult; readonly failed?: undefined }
  | { readonly failed: string; readonly result?: undefined }
)

// The sessions a terminal's menu offers to move it to, most recently visited first, the one
// it's in left out, and at most `limit`; the rest are a pick away in the Sessions panel.
export const moveSessions = <Session extends Pick<WorkspaceSession, "id" | "visitedAt">>(
  sessions: readonly Session[],
  current: string,
  limit: number,
): readonly Session[] =>
  sessions
    .filter((session) => session.id !== current)
    .toSorted((a, b) => (b.visitedAt ?? -1) - (a.visitedAt ?? -1))
    .slice(0, limit)

// A name for the session a terminal starts on its own: the terminal's, made unique in its
// project as a fresh session's is ("Search index (2)").
export const freshSessionName = (name: string, sessions: readonly WorkspaceSession[]): string => {
  const base = name.trim() || "Session"
  const taken = new Set(sessions.map((session) => session.name))
  if (!taken.has(base)) return base
  let suffix = 2
  while (taken.has(`${base} (${suffix})`)) suffix += 1
  return `${base} (${suffix})`
}

// What the toast says of a move: where it went and that it still runs, then what changed.
export const movedWords = (notice: MoveNotice): string => {
  if (notice.failed !== undefined)
    return `Couldn't move ${notice.name} to ${notice.session.name}. ${notice.failed}`
  const { moved, left } = notice.result
  const [first, ...team] = moved
  const handle = first && first.handle !== first.was ? `, now as @${first.handle}` : ""
  const along = team.length
    ? ` with ${team.length} ${team.length === 1 ? "teammate" : "teammates"}`
    : ""
  const leaving = left ? ` It left @${left}'s team.` : ""
  const where = notice.fresh ? "a new session" : notice.session.name
  return `${notice.name} moved to ${where}${along}, still running${handle}.${leaving}`
}
