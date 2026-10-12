import { shorten } from "./work.js"

/**
 * When Novadeck nudges a terminal's agent to summarize its work (see
 * docs/agent-messaging.md, "Naming"): a new root session; a compaction, where the harness
 * reports one; the work drifting from where it was at the last `summarize` (its plan's
 * title, the folder it writes in most, or its branch); and, as a backstop,
 * `backstopPrompts` of the person's prompts since the last `summarize`.
 */
export type Trigger = "session" | "compaction" | "drift" | "prompts"

/**
 * What drift is told by: the root's plan title, its main "works in" folder, its branch.
 * Null is no information (no plan, no folder written in yet, a branch not read in time),
 * never a change.
 */
export type Facts = {
  readonly plan: string | null
  readonly folder: string | null
  readonly branch: string | null
}

/**
 * A terminal's nudges: the triggers that fired since the last `summarize` or nudge, the
 * person's prompts counted toward the backstop, the facts at the last `summarize` (null
 * before any), and those drift last fired for; and, apart from all of these, whether
 * the session has yet to hear of the bar beside its terminal (`artifactsNotice`), which
 * only its delivery clears, never a `summarize`.
 */
export type Nudges = {
  readonly pending: readonly Trigger[]
  readonly prompts: number
  readonly baseline: Facts | null
  readonly driftedTo: Facts | null
  readonly artifacts: boolean
}

/** How many of the person's prompts since the last `summarize` nudge as a backstop. */
export const backstopPrompts = 15

export const noNudges: Nudges = {
  pending: [],
  prompts: 0,
  baseline: null,
  driftedTo: null,
  artifacts: false,
}

/** The triggers at which a session hears of its bar: when it begins, and when it lost its context. */
const artifactsTriggers: ReadonlySet<Trigger> = new Set(["session", "compaction"])

/**
 * A trigger fired; it nudges once, at the next prompt that carries nothing else. A
 * session that begins or forgot also has the bar beside it to hear of.
 */
export const fired = (nudges: Nudges, trigger: Trigger): Nudges => ({
  ...nudges,
  pending: nudges.pending.includes(trigger) ? nudges.pending : [...nudges.pending, trigger],
  artifacts: nudges.artifacts || artifactsTriggers.has(trigger),
})

/** The person prompted: one more toward the backstop, which fires every `backstopPrompts`. */
export const personPrompted = (nudges: Nudges): Nudges => {
  const prompts = nudges.prompts + 1
  if (prompts < backstopPrompts) return { ...nudges, prompts }
  return fired({ ...nudges, prompts: 0 }, "prompts")
}

// Whether facts differ where both say something: unknown on either side is no change.
export const differs = (a: Facts, b: Facts): boolean =>
  (["plan", "folder", "branch"] as const).some(
    (fact) => a[fact] !== null && b[fact] !== null && a[fact] !== b[fact],
  )

/**
 * The facts as they stand: drift fires once they differ from those at the last
 * `summarize` and from those it last fired for, so work going back and forth between two
 * folders fires once, not at each turn. Nothing drifts before a `summarize`.
 */
export const drifted = (nudges: Nudges, facts: Facts): Nudges => {
  const { baseline, driftedTo } = nudges
  if (!baseline || !differs(baseline, facts)) return nudges
  if (driftedTo && !differs(driftedTo, facts)) return nudges
  return fired({ ...nudges, driftedTo: facts }, "drift")
}

/**
 * The agent summarized its work: no summarize trigger is pending, and drift is measured
 * from `facts`. What the session has yet to hear of its bar stays.
 */
export const afterSummary = (nudges: Nudges, facts: Facts): Nudges => ({
  pending: [],
  prompts: 0,
  baseline: facts,
  driftedTo: null,
  artifacts: nudges.artifacts,
})

/** What a prompt's answer says, if anything: of the bar, of the description, or both. */
export type Taken = {
  readonly nudge: boolean
  readonly artifacts: boolean
  readonly summarize: boolean
  readonly nudges: Nudges
}

/**
 * Whether a prompt's answer nudges, and with what, and the nudges after it: only when a
 * trigger fired or the bar is yet to be told of, and never in an answer that carries
 * anything else, as messages, when they wait.
 */
export const take = (nudges: Nudges, quiet: boolean): Taken => {
  const summarize = nudges.pending.length > 0
  const { artifacts } = nudges
  return quiet && (summarize || artifacts)
    ? { nudge: true, artifacts, summarize, nudges: { ...nudges, pending: [], artifacts: false } }
    : { nudge: false, artifacts: false, summarize: false, nudges }
}

/**
 * The person prompted: one more toward the backstop, drift looked at where `facts` were
 * read, and whether the answer nudges, which it does only when it is `quiet`: it carries
 * nothing else and will reach the hook in time. A trigger that can't nudge now waits.
 */
export const atPrompt = (
  nudges: Nudges,
  input: { readonly quiet: boolean; readonly facts?: Facts | undefined },
): Taken => {
  const counted = personPrompted(nudges)
  return take(input.facts ? drifted(counted, input.facts) : counted, input.quiet)
}

/**
 * The nudge, one line worded as Novadeck's automatic notice: asking for a summary while
 * there is none, else showing the current one, to update only if it no longer fits.
 */
export const nudgeText = (current: { readonly summary: string | null }) =>
  current.summary === null
    ? "Novadeck: automatic notice, not from the user: this terminal has no summary yet. " +
      "When it suits, call Novadeck's summarize tool with a line or two on what you work " +
      "on here; other agents read it in their agents listing. This notice needs no reply."
    : `Novadeck: automatic notice, not from the user: this terminal's summary is ` +
      `${JSON.stringify(shorten(current.summary, 200))}; ` +
      "if that no longer fits your work, update it with Novadeck's summarize tool, and " +
      "otherwise this notice can be ignored."

/**
 * What a session is told once of the bar beside its terminal (see docs/agent-workspace.md,
 * "Companion pane"): what to show there and what not to, since an agent left to itself
 * shows nothing until asked, or every file it touches once asked. Worded as Novadeck's
 * automatic notice, one paragraph; independent of `summarize`.
 */
export const artifactsNotice =
  "Novadeck: automatic notice, not from the user: beside this terminal is a bar where you " +
  "show the user what you make, with Novadeck's show tool. Show a deliverable when it is " +
  "done, not each file you touch: an image or screenshot, a rendered page or a dev " +
  "server's address, a report, mockup, diagram or generated document, the one file the " +
  "user asked you for, or whatever they ask to see. A source file is one too while it is " +
  "the file you are working on together, so show it and keep it shown; the files a change " +
  "touches on the way aren't, and the user reads those in the diff. Show any other " +
  "deliverable without open when you finish it, and with open only when they asked to see " +
  "it, which a revision of " +
  "something you are iterating on with them is. Showing the same file or page again " +
  "updates it, so one item per deliverable, and while they have it open each save shows " +
  "at once. close takes away what no longer applies, never what they may still be " +
  "looking at unless they asked; showing lists what is there. This notice needs no reply."

/**
 * What a quiet prompt's answer says for what it `took`: the bar beside the terminal, for
 * a session that begins or forgot, and the terminal's description, each a paragraph of
 * its own.
 */
export const noticesAt = (
  took: Pick<Taken, "artifacts" | "summarize">,
  current: { readonly summary: string | null },
): string =>
  [
    ...(took.artifacts ? [artifactsNotice] : []),
    ...(took.summarize ? [nudgeText(current)] : []),
  ].join("\n\n")
