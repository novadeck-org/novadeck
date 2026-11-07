// The sessions whose notice of parts the chat can't read the person dismissed, for as long
// as the page lives: the chat comes and goes as they visit its terminal, and the notice
// stays dismissed. A session is its own: another one in the terminal can tell it again.
const dismissed = new Set<string>()

/** Whether the person dismissed the session's notice. */
export const unreadDismissed = (session: string): boolean => dismissed.has(session)

/** Keeps the session's notice dismissed. */
export const dismissUnread = (session: string): void => void dismissed.add(session)

// The prompts the record never got that the person sent again or took back, for as long as the
// page lives: the receipt stays, and they are dealt with. A new set for each, for a view to tell.
let settled: ReadonlySet<string> = new Set()

/** The prompts the person dealt with, by ref. */
export const settledSent = (): ReadonlySet<string> => settled

/** Keeps the prompt's line off the chat. */
export const settleSent = (ref: string): void => {
  settled = new Set([...settled, ref])
}
