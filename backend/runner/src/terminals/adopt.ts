import { DomainError } from "../errors.js"
import type { CallsHost } from "./calls.js"
import { teamNotice } from "./teams.js"

/**
 * Makes the terminal `leadId`'s teammate with no approval asked, for the tour's second fixer,
 * which the person asked for by opening the terminal at the tour's prompt: as `join` does once
 * approved, the terminal is kept as led (shown to watchers, told to messaging), the lead is
 * told it joined and may address it. A terminal or lead the runner doesn't have is
 * TERMINAL_NOT_FOUND.
 */
export const adoptTeammate = (
  host: Pick<CallsHost, "records" | "bindings" | "messaging" | "peers">,
  terminalId: string,
  leadId: string,
): void => {
  const member = host.records().get(terminalId)
  const lead = host.records().get(leadId)
  if (!member || !lead) throw new DomainError("TERMINAL_NOT_FOUND")
  host.bindings().setLead(member, leadId)
  host
    .messaging()
    .notice(leadId, teamNotice.joined(member.summary.handle, member.summary.title, true), {
      always: true,
    })
  // The notice names the member, so its handle is the lead's to use.
  host.peers().introduce(leadId, terminalId)
}
