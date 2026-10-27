import type { AgentName } from "@novadeck/protocol"

import type { Record } from "../record.js"

/**
 * The agent session a terminal's reports are read from while none is bound: the one the
 * runner resumed in its shell after a restart (`resumeClaim`), until a binding has ended
 * there. A fresh agent the person starts later, or in a restarted shell, is another session
 * and has no report yet. Undefined otherwise. The one rule behind both the terminal's
 * `reported` and the agents listing's "reported done".
 */
export const savedSession = (
  record: Pick<Record, "bound" | "resumeClaim" | "resumeEnded"> | undefined,
): { readonly agent: AgentName; readonly sessionId: string } | undefined => {
  if (!record || record.bound || record.resumeEnded || !record.resumeClaim) return undefined
  const split = record.resumeClaim.indexOf(":")
  return split < 1
    ? undefined
    : {
        agent: record.resumeClaim.slice(0, split) as AgentName,
        sessionId: record.resumeClaim.slice(split + 1),
      }
}
