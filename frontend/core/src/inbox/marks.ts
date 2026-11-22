import { atTerminal, inboxType, terminalNeed, type InboxEntry } from "../inbox"
import type { InboxMarks } from "../terminals/ending"
import type { TerminalKey } from "../types"

// The kind of dialog an entry stands for, where it stands for one: a request is the dialog
// its agent's harness shows.
const dialogOf = (entry: InboxEntry): InboxMarks["dialog"] =>
  entry.kind === "request" ? entry.request.kind : undefined

const subjectOf = (entry: InboxEntry): string | undefined => {
  if (entry.kind === "ask") return entry.ask.subject
  if (entry.kind === "request") return entry.request.subject ?? undefined
  return undefined
}

// The marks of one terminal from the landed Inbox's entries: an ask the landing rule still holds
// back (`heldBack`) makes none yet. `now` decides whether a limit has reset.
// Where all it needs is snoozed, it says so, with what the snoozed would need and its subject.
export const inboxMarks = (
  entries: readonly InboxEntry[],
  at: TerminalKey,
  now: number,
): InboxMarks => {
  const need = terminalNeed(entries, at, now)
  const mine = entries.filter(
    (entry) => atTerminal(entry, at) && !entry.settled && !entry.snoozed && !entry.heldBack,
  )
  const behind = need && mine.find((entry) => inboxType(entry) === need)
  const asleep = entries.filter((entry) => atTerminal(entry, at) && !entry.settled && entry.snoozed)
  // Its snoozed requests, whose live dialogs then make no mark.
  const requests = asleep.filter((entry) => entry.kind === "request").length
  if (need)
    return {
      need,
      subject: behind ? subjectOf(behind) : undefined,
      dialog: behind ? dialogOf(behind) : undefined,
      ...(requests > 0 ? { snoozedRequests: requests } : {}),
    }
  const would = terminalNeed(
    asleep.map(({ snoozed: _snoozed, ...entry }) => entry as InboxEntry),
    at,
    now,
  )
  const first = would && asleep.find((entry) => inboxType(entry) === would)
  return would
    ? {
        need: undefined,
        subject: first ? subjectOf(first) : undefined,
        snoozed: true,
        snoozedRequests: requests,
      }
    : { need: undefined, subject: undefined, dialog: undefined }
}
