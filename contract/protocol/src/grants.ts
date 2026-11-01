import { z } from "zod"

import { id } from "./fields.js"

// The person's grants (#587, #588): what a lead's team, or one terminal, may run without asking
// again, made only by the person's click on Novadeck's own card. The runner enforces a grant in
// each harness's own permission hook; see architecture/team-issues/approvals-design.md.

/** The fixed scopes, each matched by an allowlist in `@novadeck/harness-core/grants`. */
export const grantPreset = z.enum(["push", "pr"])

/**
 * How long a grant lasts, as the person chooses on the card or the approval: until the
 * agent reports done (and in any case until its lead releases it or its agent exits), or
 * at most an hour. Either way a day without activity ends it.
 */
export const grantLifetime = z.enum(["until-done", "hour"])

/** Why a terminal's coverage by a grant ended; the grant itself may go on for others. */
export const grantEndWhy = z.enum(["done", "released", "exited"])
export const maxGrantEnded = 256

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
    .max(160)
    .regex(/^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "github.com/owner/name"),
  defaultBranch: z.string().min(1).max(100),
  // Where the default branch came from: GitHub itself, the remote's HEAD ref (which an agent
  // can write), or the main/master guess.
  defaultFrom: z.enum(["github", "remote-head", "guess"]),
})
export const maxGrantRepos = 6

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
  lifetime: grantLifetime,
  // The clock time an `hour` grant ends; null for `until-done`.
  endsAt: z.number().nullable(),
  // The last hook report from a terminal it covers. The runner keeps it exactly in memory and
  // saves it at most every five minutes; a day without it ends the grant.
  lastActivityAt: z.number(),
  // Who is covered right now, as `grants.watch` sends it: the team's current direct teammates
  // (and the lead when ticked), less those whose coverage ended and those whose agent isn't
  // running; a terminal grant's holder while covered. The runner fills it; a stored grant has none.
  covering: z
    .array(z.strictObject({ terminalId: z.string(), handle: z.string() }))
    .max(maxGrantEnded)
    .default([]),
  // The terminals whose coverage ended, for good: the grant goes on for the others.
  ended: z
    .array(
      z.strictObject({
        terminalId: z.string(),
        handle: z.string(),
        at: z.number(),
        why: grantEndWhy,
      }),
    )
    .max(maxGrantEnded),
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
  // What the card starts on; the lead names none, and the person picks.
  lifetime: grantLifetime,
  // The lead's own words, shown as quoted agent text.
  reason: z.string().max(2048),
  // The handles the grant covers now (later teammates are covered too), and which of them run
  // a harness the grant reaches only partly, so the card can say so.
  // `started`: its agent is already running, which for Antigravity matters (a grant reaches one
  // started after it). `plan`: its Antigravity was started in plan mode, which no grant reaches.
  covered: z
    .array(
      z.strictObject({
        handle: z.string(),
        agent: z.string(),
        started: z.boolean(),
        plan: z.boolean().default(false),
      }),
    )
    .max(256),
  // The installed Antigravity is older than 1.4.10, which takes no launch grant, and a covered
  // teammate runs it.
  agyOutdated: z.boolean(),
})

export type GrantPreset = z.infer<typeof grantPreset>
export type GrantLifetime = z.infer<typeof grantLifetime>
export type GrantEndWhy = z.infer<typeof grantEndWhy>
export type GrantCommand = z.infer<typeof grantCommand>
export type GrantRepo = z.infer<typeof grantRepo>
export type GrantHolder = z.infer<typeof grantHolder>
export type Grant = z.infer<typeof grant>
export type GrantRepoChoice = z.infer<typeof grantRepoChoice>
export type GrantProposal = z.infer<typeof grantProposal>
