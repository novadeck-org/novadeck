import {
  inboxType,
  terminalDone,
  terminalNeed,
  type InboxItem,
  type TerminalAt,
} from "@novadeck/core/inbox"
import type { TerminalNeed } from "@novadeck/core/terminal-ending"

// What the Inbox says of one terminal for its tab and window: the need its items make, a done
// report it has not been looked at for, and the words of the item that makes the need.
export type InboxMarks = {
  readonly need: TerminalNeed | undefined
  readonly done: boolean
  // The subject of the item behind the need, where it has one.
  readonly subject: string | undefined
}

const here = (item: InboxItem, at: TerminalAt): boolean =>
  item.source.projectId === at.projectId &&
  item.source.workspaceSessionId === at.workspaceSessionId &&
  item.source.terminalId === at.terminalId

const subjectOf = (item: InboxItem): string | undefined => {
  if (item.kind === "ask") return item.ask.subject
  if (item.kind === "request") return item.request.subject ?? undefined
  return undefined
}

// The marks of one terminal from the Inbox's items: raw ones, as the backend lists them, since
// the landing rule hides rows from the Inbox, never from the marks. `now` decides whether a
// limit has reset.
export const inboxMarks = (
  items: readonly InboxItem[],
  at: TerminalAt,
  now: number,
): InboxMarks => {
  const need = terminalNeed(items, at, now)
  const mine = items.filter((item) => here(item, at))
  const behind = need && mine.find((item) => inboxType(item) === need)
  return { need, done: terminalDone(mine, at), subject: behind ? subjectOf(behind) : undefined }
}
