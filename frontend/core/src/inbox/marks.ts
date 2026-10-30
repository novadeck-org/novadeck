import { atTerminal, inboxType, terminalNeed, type InboxRow, type TerminalAt } from "../inbox"
import type { InboxMarks } from "../terminals/ending"

// The kind of dialog a row stands for, where it stands for one: a request is the dialog
// its agent's harness shows.
const dialogOf = (row: InboxRow): InboxMarks["dialog"] =>
  row.kind === "request" ? row.request.kind : undefined

const subjectOf = (row: InboxRow): string | undefined => {
  if (row.kind === "ask") return row.ask.subject
  if (row.kind === "request") return row.request.subject ?? undefined
  return undefined
}

// The marks of one terminal from the Inbox's rows: raw ones, as the backend lists them, since
// the landing rule hides rows from the Inbox, never from the marks. `now` decides whether a
// limit has reset.
export const inboxMarks = (rows: readonly InboxRow[], at: TerminalAt, now: number): InboxMarks => {
  const need = terminalNeed(rows, at, now)
  const mine = rows.filter((row) => atTerminal(row, at) && !row.settled)
  const behind = need && mine.find((row) => inboxType(row) === need)
  return {
    need,
    subject: behind ? subjectOf(behind) : undefined,
    dialog: behind ? dialogOf(behind) : undefined,
  }
}
