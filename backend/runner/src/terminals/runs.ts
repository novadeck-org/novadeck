import { notice } from "./closes.js"
import { mention } from "./handles.js"

/**
 * What an agent hears when its `open_terminal` with a command waits for the person: at once
 * that they were asked, then, as a notice, how they answered. The terminal opens only once
 * they confirm.
 */
export const runNotice = {
  opened: (handle: string, command: string): string =>
    notice +
    `The user approved running \`${command}\`: it is open as ${mention(handle)} and the command started.`,
  declined: (command: string): string =>
    notice + `The user declined running \`${command}\`: no terminal opened and nothing ran.`,
  // The asking terminal closed, or its folder or the client went away.
  gone: (command: string): string =>
    notice +
    `Nothing ran: Novadeck's window went away before the user answered the ask to run ` +
    `\`${command}\`. Ask again if it still should.`,
  refused: (command: string, reason: string): string =>
    notice + `The user approved running \`${command}\`, but no terminal opened: ${reason}`,
}

/** What an agent hears when no window of Novadeck is open to ask the person. */
export const nobodyToRun = "Novadeck isn't open to ask the user, so no terminal opened."

/** What an agent hears when it asked to run a command and the person has not answered yet. */
export const waitingToRun =
  "An earlier request from this terminal is still waiting for the user's answer, so nothing opened."
