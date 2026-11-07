// The prompts the record never got that the person sent again or took back, for as long as the
// page lives: the receipt stays, and they are dealt with. A new set for each, for a view to tell.
let settled: ReadonlySet<string> = new Set()

/** The prompts the person dealt with, by ref. */
export const settledSent = (): ReadonlySet<string> => settled

/** Keeps the prompt's line off the chat. */
export const settleSent = (ref: string): void => {
  settled = new Set([...settled, ref])
}
