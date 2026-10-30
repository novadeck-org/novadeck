/**
 * Claude Code's records of an interrupted turn: a user message in brackets, for Esc while
 * it works or runs a tool, and for "No" to a permission request, which interrupts the turn
 * too.
 */
const marker = "[Request interrupted by user"

/** Whether a transcript line may hold one, before it is parsed. */
export const mentionsInterruption = (line: string): boolean => line.includes(marker)

/**
 * The exact texts that end the turn: only these count, so a prompt that merely starts like
 * one does not.
 */
export const interruptions: ReadonlySet<string> = new Set([`${marker}]`, `${marker} for tool use]`])

const shown = /^\s*\[Request interrupted by user[^\]]*\]\s*$/

/** Whether a user's text is one, however it was written, as the chat shows it. */
export const interruption = (text: string): boolean => shown.test(text)
