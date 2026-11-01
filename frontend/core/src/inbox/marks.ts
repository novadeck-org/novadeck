import { approvalTitle } from "../grants"
import { atTerminal, inboxType, terminalNeed, type InboxRow } from "../inbox"
import type { InboxMarks } from "../terminals/ending"
import type { TerminalKey } from "../types"

// The kind of dialog a row stands for, where it stands for one: a request is the dialog
// its agent's harness shows.
const dialogOf = (row: InboxRow): InboxMarks["dialog"] =>
  row.kind === "request" ? row.request.kind : undefined

const subjectOf = (row: InboxRow): string | undefined => {
  if (row.kind === "ask") return row.ask.shape.type === "approval" ? approvalTitle : row.ask.subject
  if (row.kind === "request") return row.request.subject ?? undefined
  return undefined
}

// The marks of one terminal from the Inbox's rows: raw ones, as the backend lists them, since
// the landing rule hides rows from the Inbox, never from the marks. `now` decides whether a
// limit has reset.
// Where all it needs is snoozed, it says so, with what the snoozed would need and its subject.
export const inboxMarks = (rows: readonly InboxRow[], at: TerminalKey, now: number): InboxMarks => {
  const need = terminalNeed(rows, at, now)
  const mine = rows.filter((row) => atTerminal(row, at) && !row.settled && !row.snoozed)
  const behind = need && mine.find((row) => inboxType(row) === need)
  const asleep = rows.filter((row) => atTerminal(row, at) && !row.settled && row.snoozed)
  // Its snoozed requests, whose live dialogs then make no mark.
  const requests = asleep.filter((row) => row.kind === "request").length
  if (need)
    return {
      need,
      subject: behind ? subjectOf(behind) : undefined,
      dialog: behind ? dialogOf(behind) : undefined,
      ...(requests > 0 ? { snoozedRequests: requests } : {}),
    }
  const would = terminalNeed(
    asleep.map(({ snoozed: _snoozed, ...row }) => row as InboxRow),
    at,
    now,
  )
  const first = would && asleep.find((row) => inboxType(row) === would)
  return would
    ? {
        need: undefined,
        subject: first ? subjectOf(first) : undefined,
        snoozed: true,
        snoozedRequests: requests,
      }
    : { need: undefined, subject: undefined, dialog: undefined }
}
