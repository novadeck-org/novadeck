import { z } from "zod"

// Cmd's AutoRun (Windows): where it prints, Antigravity asks for each command and its hooks'
// answers can't be read outside Novadeck's terminals, and Novadeck offers the person a
// one-click rewrite that silences its output (approvals-design.md, Appendix F). These are the
// states the Inbox's card and Preferences show; only the person's click changes anything.

/**
 * The longest AutoRun value the runner rewrites, in characters; the rewrite is 11 longer
 * (`(` `) >nul 2>&1`), so a value as shown or sent back may be up to `maxAutoRunShown`.
 */
export const maxAutoRunValue = 4_000
export const maxAutoRunShown = maxAutoRunValue + 16

const value = z.string().max(maxAutoRunShown)
const sentence = z.string().max(400)

/** What the person's last click came to, shown on the card until the next one. */
export const autorunOutcome = z.discriminatedUnion("kind", [
  // Rewritten, and cmd prints nothing now. Antigravity's plugin is installed again once the
  // `waiting` terminals (Antigravity running in Novadeck) are closed, and where `restart` is
  // set, once Novadeck has started again after a previous run's narrowed terminals are gone.
  z.strictObject({
    kind: z.literal("applied-clean"),
    waiting: z.array(z.string()).max(256),
    restart: z.boolean(),
  }),
  // Rewritten, but cmd still prints: the machine's AutoRun (HKLM) does, which Novadeck doesn't change.
  z.strictObject({ kind: z.literal("applied-still-prints-hklm") }),
  // Rewritten, but cmd still printed and nothing else was to blame, so it was put back.
  z.strictObject({ kind: z.literal("rolled-back") }),
  // The value changed since the card showed it: nothing was written.
  z.strictObject({ kind: z.literal("conflict") }),
  z.strictObject({ kind: z.literal("failed"), message: sentence }),
  z.strictObject({ kind: z.literal("undone") }),
  // Undo waits for every Antigravity terminal of Novadeck to close; `restart` where the terminals
  // are a previous Novadeck's, which only a start of Novadeck again settles.
  z.strictObject({
    kind: z.literal("undo-refused"),
    terminals: z.array(z.string()).max(256),
    restart: z.boolean(),
  }),
])

/** Why Novadeck can't do the change itself and gives the person the step instead. */
export const autorunManualReason = z.enum([
  // The printing value is in HKLM, which needs an administrator.
  "machine",
  // The rewrite refuses the value (`rule` says why), or would still print.
  "refused",
  // The value isn't plain text Novadeck can restore byte for byte, or can't be read.
  "form",
  // Alone, the person's value prints nothing: the output comes from elsewhere.
  "quiet",
  // Whether the value prints could not be told (cmd ran too long or didn't start).
  "unchecked",
])

const outcome = autorunOutcome.nullable()
// The person said not now to the Inbox's line, for the value it showed: Preferences still offers
// the fix. A changed value offers again.
const dismissed = z.boolean()

export const autorunState = z.discriminatedUnion("state", [
  // Nothing to offer: another platform, cmd prints nothing, or the person said not now.
  z.strictObject({ state: z.literal("none"), outcome, dismissed }),
  // The person's value, the exact new one, and the machine's (HKLM) value where there is one.
  z.strictObject({
    state: z.literal("offer"),
    current: value,
    next: value,
    machine: value.nullable(),
    outcome,
    dismissed,
  }),
  z.strictObject({
    state: z.literal("manual"),
    reason: autorunManualReason,
    // The rule that refused the value, for "refused".
    rule: sentence.nullable(),
    current: value.nullable(),
    machine: value.nullable(),
    // What the value could become if the person changes it, where the rewrite accepts it.
    suggested: value.nullable(),
    outcome,
    dismissed,
  }),
  // The person's value is Novadeck's wrapper; Undo puts `restores` back exactly.
  z.strictObject({
    state: z.literal("silenced"),
    current: value,
    restores: value,
    machine: value.nullable(),
    // What the machine's value could become if the person changes it, where the rewrite accepts it.
    suggested: value.nullable(),
    outcome,
    dismissed,
  }),
])

export type AutoRunOutcome = z.infer<typeof autorunOutcome>
export type AutoRunManualReason = z.infer<typeof autorunManualReason>
export type AutoRunState = z.infer<typeof autorunState>
