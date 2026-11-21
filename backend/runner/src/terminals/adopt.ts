import { DomainError } from "../errors.js"
import type { CallsHost } from "./calls.js"
import { teamNotice } from "./teams.js"

/** How long a shell's first prompt is waited for, and how often it is looked for. */
export const promptWait = { ms: 8_000, pollMs: 50 }

/**
 * Resolves once the terminal's shell has drawn its first prompt (its integration reported one, which `promptedAt` keeps),
 * so a line typed then isn't read by a profile still loading, or gives up after `promptWait.ms`:
 * a shell without integration never reports one, and is typed into as it is.
 */
const firstPrompt = async (host: Pick<CallsHost, "records">, terminalId: string): Promise<void> => {
  const until = Date.now() + promptWait.ms
  while (Date.now() < until) {
    const record = host.records().get(terminalId)
    if (!record || record.promptedAt !== null) return
    // eslint-disable-next-line no-await-in-loop -- Polled in turn.
    await new Promise((resolve) => setTimeout(resolve, promptWait.pollMs))
  }
}

/**
 * Makes the terminal `leadId`'s teammate with no approval asked, for the tour's second fixer,
 * which the person asked for by opening the terminal at the tour's prompt: as `join` does once
 * approved, once its shell has shown its first prompt (`firstPrompt`), the terminal is kept as led (shown to watchers, told to messaging), the lead is
 * told it joined and may address it. A terminal or lead the runner doesn't have is
 * TERMINAL_NOT_FOUND.
 */
export const adoptTeammate = async (
  host: Pick<CallsHost, "records" | "bindings" | "messaging" | "peers">,
  terminalId: string,
  leadId: string,
  /** Run once the prompt shows, before the adoption: the tour's checks and launch line; may throw. */
  before: () => void = () => undefined,
): Promise<void> => {
  await firstPrompt(host, terminalId)
  before()
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
