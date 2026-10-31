import { z } from "zod"

import { id } from "./fields.js"

// The person's grants (#587, #588): what a lead's team, or one terminal, may run without asking
// again, made only by the person's click on Novadeck's own card. The runner enforces a grant in
// each harness's own permission hook; see architecture/team-issues/approvals-design.md.

/** The fixed scopes, each matched by an allowlist in `@novadeck/harness-core/grants`. */
export const grantPreset = z.enum(["push", "pr"])

/** How long a grant lasts, in hours: the card offers these, and 24 is the most. */
export const grantHours = z.union([z.literal(1), z.literal(8), z.literal(24)])

// One word of a granted command: printable ASCII, as the matcher's lexer reads it.
const word = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x20-\x7e]+$/, "Use printable ASCII")

/** A command the person grants: exact words, or with `rest`, followed by anything. */
export const grantCommand = z.strictObject({
  argv: z.array(word).min(1).max(32),
  rest: z.boolean(),
})
export const maxGrantCommands = 8

/** A repo push and pr may reach: `github.com/owner/name`, with its default branch. */
export const grantRepo = z.strictObject({
  url: z
    .string()
    .max(256)
    .regex(/^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "github.com/owner/name"),
  defaultBranch: z.string().min(1).max(256),
  // Where the default branch came from: GitHub itself, the remote's HEAD ref (which an agent
  // can write), or the main/master guess.
  defaultFrom: z.enum(["github", "remote-head", "guess"]),
})
export const maxGrantRepos = 16

/** Who may use a grant. */
export const grantHolder = z.discriminatedUnion("kind", [
  // The terminals the lead leads directly, now and later; the lead itself only if `withLead`.
  z.strictObject({ kind: z.literal("team"), lead: z.string(), withLead: z.boolean() }),
  z.strictObject({ kind: z.literal("terminal"), handle: z.string() }),
])

export const grant = z.strictObject({
  id,
  projectId: id,
  workspaceSessionId: id,
  holder: grantHolder,
  presets: z.array(grantPreset).max(2),
  commands: z.array(grantCommand).max(maxGrantCommands),
  repos: z.array(grantRepo).max(maxGrantRepos),
  // The Inbox entry it was made from, and the handle of the agent that proposed or asked.
  entryId: id,
  proposedBy: z.string(),
  madeAt: z.number(),
  endsAt: z.number(),
  revokedAt: z.number().nullable(),
  // The last command it allowed, for the grants list.
  lastUse: z
    .strictObject({ at: z.number(), handle: z.string(), command: z.string().max(512) })
    .nullable(),
})

/**
 * A repo the Grant card offers: ticked when it is the `origin` of a repo under the project
 * folder that wasn't made or re-pointed in the last day; `flag` says why one isn't.
 */
export const grantRepoChoice = z.strictObject({
  repo: grantRepo,
  ticked: z.boolean(),
  flag: z.enum(["added-remote", "recent"]).nullable(),
})

/** A lead's proposal, as the Inbox's Grant card shows it. */
export const grantProposal = z.strictObject({
  presets: z.array(grantPreset).max(2),
  commands: z.array(grantCommand).max(maxGrantCommands),
  repos: z.array(grantRepoChoice).max(maxGrantRepos),
  withLead: z.boolean(),
  hours: grantHours,
  // The lead's own words, shown as quoted agent text.
  reason: z.string().max(2048),
  // The handles the grant covers now (later teammates are covered too), and which of them run
  // a harness the grant reaches only partly, so the card can say so.
  covered: z.array(z.strictObject({ handle: z.string(), agent: z.string() })).max(256),
})

export type GrantPreset = z.infer<typeof grantPreset>
export type GrantHours = z.infer<typeof grantHours>
export type GrantCommand = z.infer<typeof grantCommand>
export type GrantRepo = z.infer<typeof grantRepo>
export type GrantHolder = z.infer<typeof grantHolder>
export type Grant = z.infer<typeof grant>
export type GrantRepoChoice = z.infer<typeof grantRepoChoice>
export type GrantProposal = z.infer<typeof grantProposal>
