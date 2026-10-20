import { clearUnread } from "../../terminals/unread-state"
import type { CommandContext } from "./context"

// Which finish: the terminal and the session context that holds it.
type Finish = { readonly context: string; readonly terminalId: string }

export type FinishCommands = {
  // Reads finishes, as the Inbox does once the person reads their updates: each terminal's
  // unread turn end, in the session context that holds it, is cleared, and no other.
  readonly readFinishes: (finishes: readonly Finish[]) => void
}

export const createFinishCommands = ({ ui }: Pick<CommandContext, "ui">): FinishCommands => ({
  readFinishes: (finishes) =>
    void ui.update((state) => {
      const unread = finishes.reduce(
        (left, { context, terminalId }) => clearUnread(left, context, terminalId),
        state.unread,
      )
      return unread === state.unread ? state : { ...state, unread }
    }),
})
