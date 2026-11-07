import type { InboxRow } from "@novadeck/core/inbox"
import { handleText } from "@novadeck/core/terminals/handle"
import type { WorkspaceProject } from "@novadeck/core/types"

import {
  mostPressingOf,
  sessionStatuses,
  type ProjectStatus,
  type UnreadEnds,
} from "../projects/project-status"

// What the Sessions panel says of one session's terminals beyond how many there are: the most
// pressing status they show (what the project rows mark, over this session alone), how many
// need the person or ask, and the lines naming those terminals for the row's tooltip.
export type SessionMark = {
  readonly status: ProjectStatus | undefined
  // The terminals whose status is `unblock`, and `ask`.
  readonly needsYou: number
  readonly asks: number
  readonly failed: number
  readonly done: number
  // `Needs you: @glint · Polish and updates`, the terminals that need the person first, then
  // those that ask, up to three, then `and N more`.
  readonly lines: readonly string[]
}

const namedLines = 3

// Each session of the project's mark, by its id.
export const sessionMarks = (
  project: WorkspaceProject,
  unread: UnreadEnds,
  rows: readonly InboxRow[],
  now: number,
): Readonly<Record<string, SessionMark>> => {
  const marks: Record<string, SessionMark> = {}
  for (const session of project.history) {
    const shown = sessionStatuses(project, session, unread, rows, now)
    const count = (status: ProjectStatus): number =>
      shown.filter((each) => each.status === status).length
    const named = (status: "unblock" | "ask", label: string): string[] =>
      shown
        .filter((each) => each.status === status)
        .map(
          ({ terminal }) =>
            `${label}: ${terminal.handle ? `${handleText(terminal.handle)} · ` : ""}${terminal.name}`,
        )
    const all = [...named("unblock", "Needs you"), ...named("ask", "Asks")]
    const lines =
      all.length > namedLines
        ? [...all.slice(0, namedLines), `and ${all.length - namedLines} more`]
        : all
    marks[session.id] = {
      status: mostPressingOf(shown.map(({ status }) => status)),
      needsYou: count("unblock"),
      asks: count("ask"),
      failed: count("failed"),
      done: count("done"),
      lines,
    }
  }
  return marks
}

export const sameSessionMarks = (
  a: Readonly<Record<string, SessionMark>>,
  b: Readonly<Record<string, SessionMark>>,
): boolean => JSON.stringify(a) === JSON.stringify(b)

const needsYouText = (count: number): string => `${count} ${count === 1 ? "needs" : "need"} you`
const questionsText = (count: number): string =>
  `${count} ${count === 1 ? "question" : "questions"}`

// The word the detail line adds after the terminal count: the most pressing of what needs the
// person, asks, failed or done, with how many; none when no terminal shows one of them.
export const sessionNeedText = (mark: SessionMark | undefined): string | undefined => {
  if (!mark) return undefined
  if (mark.needsYou > 0) return needsYouText(mark.needsYou)
  if (mark.asks > 0) return questionsText(mark.asks)
  if (mark.failed > 0) return `${mark.failed} failed`
  if (mark.done > 0) return `${mark.done} done`
  return undefined
}

// What the other sessions than the open one ask of the person, in words for the rail's Sessions
// toggle: how many terminals need them and how many ask. Undefined while none does.
export const elsewhereSessionsText = (
  marks: Readonly<Record<string, SessionMark>>,
  openId: string,
): string | undefined => {
  let needsYou = 0
  let asks = 0
  for (const [id, mark] of Object.entries(marks))
    if (id !== openId) {
      needsYou += mark.needsYou
      asks += mark.asks
    }
  const parts = [needsYou > 0 && needsYouText(needsYou), asks > 0 && questionsText(asks)].filter(
    Boolean,
  )
  return parts.length ? parts.join(" · ") : undefined
}
