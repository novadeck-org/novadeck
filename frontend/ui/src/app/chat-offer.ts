import { chatAvailable } from "@novadeck/chat/state"
import type { Workspace } from "@novadeck/core/types"

import { currentState } from "./selectors"

// Agent Chat's one-time offer, the footer's card (AgentChatOffer.tsx): what makes it due.

// Whether the selected terminal runs an agent the chat can show, whichever view it is in: the
// test the terminal itself uses to show its chat (`chatAvailable`), so the offer comes up
// where the person would see the difference, for every harness the chat reads.
export const selectedAgentCanChat = (workspace: Workspace): boolean => {
  const { selected, roster } = currentState(workspace)
  const terminal = roster.terminals.find(({ id }) => id === selected)
  return terminal !== undefined && chatAvailable(terminal)
}

// Whether the offer is due: the backend reads conversations (the chat view has a choice in
// Preferences), the chat view is off, the offer was not answered yet or held back for this run, the welcome dialog,
// which offers the same, is not up, no tour is running (its agent is not for the offer to
// change), and the selected terminal has a chat to show.
export const chatOfferDue = (facts: {
  readonly reads: boolean
  readonly chatView: boolean
  readonly answered: boolean
  // Held back for this run (see `chatOfferHeld`).
  readonly held: boolean
  readonly welcome: boolean
  readonly canChat: boolean
  // The tour runs, or its closing card shows.
  readonly touring: boolean
}): boolean =>
  facts.reads &&
  !facts.chatView &&
  !facts.answered &&
  !facts.held &&
  !facts.welcome &&
  facts.canChat &&
  !facts.touring
