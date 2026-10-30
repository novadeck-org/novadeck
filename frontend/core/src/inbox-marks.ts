import { inboxType, terminalNeed, type InboxRow, type TerminalAt } from "./inbox"
import type { NoteMarks } from "./terminal-ending"

// What the Inbox says of one terminal for its tab and window (see `NoteMarks`).
export type InboxMarks = NoteMarks

const here = (item: InboxRow, at: TerminalAt): boolean =>
  item.source.projectId === at.projectId &&
  item.source.workspaceSessionId === at.workspaceSessionId &&
  item.source.terminalId === at.terminalId

// The kind of dialog an item stands for, where it stands for one: a request is the dialog
// its agent's harness shows.
const dialogOf = (item: InboxRow): InboxMarks["dialog"] =>
  item.kind === "request" ? item.request.kind : undefined

const subjectOf = (item: InboxRow): string | undefined => {
  if (item.kind === "ask") return item.ask.subject
  if (item.kind === "request") return item.request.subject ?? undefined
  return undefined
}

// The marks of one terminal from the Inbox's items: raw ones, as the backend lists them, since
// the landing rule hides rows from the Inbox, never from the marks. `now` decides whether a
// limit has reset.
// Where all it needs is snoozed, it says so, with what the snoozed would need and its subject.
export const inboxMarks = (items: readonly InboxRow[], at: TerminalAt, now: number): InboxMarks => {
  const need = terminalNeed(items, at, now)
  const mine = items.filter((item) => here(item, at) && !item.settled && !item.snoozed)
  const behind = need && mine.find((item) => inboxType(item) === need)
  if (need)
    return {
      need,
      subject: behind ? subjectOf(behind) : undefined,
      dialog: behind ? dialogOf(behind) : undefined,
    }
  const asleep = items.filter((item) => here(item, at) && !item.settled && item.snoozed)
  const would = terminalNeed(
    asleep.map(({ snoozed: _snoozed, ...item }) => item as InboxRow),
    at,
    now,
  )
  const first = would && asleep.find((item) => inboxType(item) === would)
  return would
    ? {
        need: undefined,
        subject: first ? subjectOf(first) : undefined,
        snoozed: true,
        snoozedRequests: asleep.filter((item) => item.kind === "request").length,
      }
    : { need: undefined, subject: undefined, dialog: undefined }
}
