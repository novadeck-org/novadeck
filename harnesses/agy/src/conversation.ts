import {
  fileIn,
  homeOfTranscript,
  rulesOf,
  sessionName,
  type Conversation,
  type ConversationScan,
} from "@novadeck/harness-core/conversation"
import type { Harness } from "@novadeck/harness-core/harness"

import { antigravityHome } from "./home.js"

/**
 * Antigravity keeps a conversation as `<home>/conversations/<session>.db`, and that file
 * decides: a resume of an id without it starts a new conversation without a word, and
 * `brain/<session>` stays after the file is gone (probed 2026-11-06, 1.5.2). One `stat`.
 * Its transcript, under `brain`, says the home when a wrapper moved it.
 */
export const conversations: Harness["conversations"] = (install): ConversationScan => {
  const rules = rulesOf(install)
  const inHome = (home: string, session: string): Promise<Conversation> => {
    const folder = rules.join(home, "conversations")
    return fileIn(folder, rules.join(folder, `${session}.db`))
  }
  return {
    conversation: async (session, known) => {
      if (!sessionName.test(session)) return "unknown"
      const hinted = homeOfTranscript(known?.transcript, "brain")
      if (hinted !== undefined) {
        const found = await inHome(hinted, session)
        if (found !== "unknown") return found
      }
      return inHome(antigravityHome(install), session)
    },
  }
}

export const conversation: Harness["conversation"] = (install, session, known) =>
  conversations(install).conversation(session, known)
