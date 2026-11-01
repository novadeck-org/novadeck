import { refusesCommand } from "@novadeck/harness-core/grants"
import {
  grantCommand,
  grantPreset,
  maxGrantCommands,
  type AgentName,
  type GrantProposal,
  type GrantRepoChoice,
} from "@novadeck/protocol"
import { z } from "zod"

import { grantCommandsRefusal } from "./grant-text.js"
import { cleanInboxText } from "./messages.js"

/** What an agent's `propose_grant` may say: closed, with no free-text scope. */
const command = z
  .strictObject({ argv: grantCommand.shape.argv, rest: z.boolean().optional() })
  .transform(({ argv, rest }) => ({ argv, rest: rest ?? false }))
  .superRefine((each, context) => {
    const refusal = refusesCommand(each)
    if (refusal !== undefined)
      context.addIssue({ code: "custom", message: `${each.argv.join(" ")}: ${refusal}` })
  })

const request = z.strictObject({
  presets: z.array(grantPreset).max(2),
  commands: z
    .array(command)
    .max(maxGrantCommands)
    .superRefine((commands, context) => {
      const refusal = grantCommandsRefusal(commands)
      if (refusal !== undefined) context.addIssue({ code: "custom", message: refusal })
    })
    .optional(),
  with_lead: z.boolean().optional(),
  reason: z.string().transform(cleanInboxText).pipe(z.string().trim().min(1).max(2048)),
})

/**
 * Reads a `propose_grant` call. Fails with a sentence for the agent: for a command the
 * matcher would refuse, and for a proposal that offers nothing.
 */
export const readProposal = (
  args: unknown,
):
  | {
      readonly ok: true
      readonly presets: GrantProposal["presets"]
      readonly commands: GrantProposal["commands"]
      readonly withLead: boolean
      readonly reason: string
    }
  | { readonly ok: false; readonly reason: string } => {
  const read = request.safeParse(args)
  if (!read.success)
    return {
      ok: false,
      reason: `That grant doesn't fit: ${read.error.issues.map((issue) => issue.message).join("; ")}.`,
    }
  const presets = [...new Set(read.data.presets)]
  const commands = read.data.commands ?? []
  if (presets.length === 0 && commands.length === 0)
    return { ok: false, reason: "Offer a preset (push, pr) or a command." }
  return {
    ok: true,
    presets,
    commands,
    withLead: read.data.with_lead ?? false,
    reason: read.data.reason,
  }
}

/** The card for a read proposal: its repos, from the sources, and who it covers now. */
export const proposalOf = (
  read: Extract<ReturnType<typeof readProposal>, { ok: true }>,
  repos: readonly GrantRepoChoice[],
  covered: readonly {
    readonly handle: string
    readonly agent: AgentName
    readonly started: boolean
  }[],
  agyOutdated = false,
): GrantProposal => ({
  presets: read.presets,
  commands: read.commands,
  // Repos matter only to push and pr.
  repos: read.presets.length > 0 ? [...repos] : [],
  withLead: read.withLead,
  // The lead names none; the card starts on until-done and the person picks.
  lifetime: "until-done",
  reason: read.reason,
  covered: covered.map(({ handle, agent, started }) => ({ handle, agent, started })),
  // Only a covered teammate that runs Antigravity makes an old one matter.
  agyOutdated: agyOutdated && covered.some(({ agent }) => agent === "agy"),
})
