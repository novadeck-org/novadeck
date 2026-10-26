import { due, noTroubles, pageNotice, spend, type PageEntry, type Troubles } from "./troubles.js"
import { shorten } from "./work.js"

/**
 * When Novadeck nudges a terminal's agent to summarize its work (see
 * docs/agent-messaging.md, "Naming"): a new root session; a compaction, where the harness
 * reports one; the work drifting from where it was at the last `summarize` (its plan's
 * title, the folder it writes in most, or its branch); as a backstop, `backstopPrompts` of
 * the person's prompts since the last `summarize`; and every prompt while the terminal has
 * no summary at all (`unsummarized`), since an agent whose first prompt gave it no work yet
 * puts the first nudge off, and the terminal has no title until it summarizes.
 */
export type Trigger = "session" | "compaction" | "drift" | "prompts" | "unsummarized"

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
 * the session has yet to hear of the bar beside its terminal (`artifactsNotice`) and of
 * the Inbox (`inboxNotice`), which only their delivery clears, never a `summarize`; and
 * the troubles the pane told of pages
 * the session showed (`troubles.ts`), which a new root session drops and only their
 * delivery otherwise clears.
 */
export type Nudges = {
  readonly pending: readonly Trigger[]
  readonly prompts: number
  readonly baseline: Facts | null
  readonly driftedTo: Facts | null
  readonly artifacts: boolean
  readonly troubles: Troubles
  /** When the current root session began, in milliseconds; only later shows are told of. */
  readonly since: number
}

/** How many of the person's prompts since the last `summarize` nudge as a backstop. */
export const backstopPrompts = 5

export const noNudges: Nudges = {
  pending: [],
  prompts: 0,
  baseline: null,
  driftedTo: null,
  artifacts: false,
  troubles: noTroubles,
  since: 0,
}

/**
 * The triggers at which a session hears of its bar: when it begins, and when it lost its
 * context.
 */
const artifactsTriggers: ReadonlySet<Trigger> = new Set(["session", "compaction"])

const raised = (nudges: Nudges, trigger: Trigger): Nudges => ({
  ...nudges,
  pending: nudges.pending.includes(trigger) ? nudges.pending : [...nudges.pending, trigger],
  artifacts: nudges.artifacts || artifactsTriggers.has(trigger),
})

/**
 * A trigger fired; it nudges once, at the next prompt that carries nothing else. A
 * session that forgot also has the bar beside it to hear of. A new session is
 * `sessionBegan`.
 */
export const fired = (nudges: Nudges, trigger: Exclude<Trigger, "session">): Nudges =>
  raised(nudges, trigger)

/**
 * A new root session began, at `at` in milliseconds: it has the bar beside it to hear of,
 * and did not show the pages the pane told of, so those go and only later shows count.
 */
export const sessionBegan = (nudges: Nudges, at: number): Nudges => ({
  ...raised(nudges, "session"),
  troubles: noTroubles,
  since: at,
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
  troubles: nudges.troubles,
  since: nudges.since,
})

/** What a prompt's answer says, if anything: of the bar and Inbox, of the description, of pages, or all. */
export type Taken = {
  readonly nudge: boolean
  readonly artifacts: boolean
  readonly summarize: boolean
  /** The pages it tells of, each once for its show. */
  readonly pages: readonly PageEntry[]
  readonly nudges: Nudges
}

/**
 * Whether a prompt's answer nudges, and with what, and the nudges after it: only when a
 * trigger fired, the bar is yet to be told of or a page has troubles to tell, and never in
 * an answer that carries anything else, as messages, when they wait. Pages go only as far
 * as `fits` accepts the answer.
 */
export const take = (
  nudges: Nudges,
  quiet: boolean,
  fits: (took: Pick<Taken, "artifacts" | "summarize" | "pages">) => boolean = () => true,
): Taken => {
  const summarize = nudges.pending.length > 0
  const { artifacts } = nudges
  const silent = { nudge: false, artifacts: false, summarize: false, pages: [], nudges }
  if (!quiet || !(summarize || artifacts || due(nudges.troubles))) return silent
  // Pages go only as far as the answer stays within what a hook may print.
  const { pages, troubles } = spend(
    nudges.troubles,
    (each) => fits({ artifacts, summarize, pages: each }),
    (page) => fits({ artifacts: false, summarize: false, pages: [page] }),
  )
  if (!summarize && !artifacts && pages.length === 0)
    return { ...silent, nudges: { ...nudges, troubles } }
  return {
    nudge: true,
    artifacts,
    summarize,
    pages,
    nudges: { ...nudges, pending: [], artifacts: false, troubles },
  }
}

/**
 * The person prompted: one more toward the backstop, drift looked at where `facts` were
 * read, a summary asked for again while there is none, and whether the answer nudges,
 * which it does only when it is `quiet`: it carries nothing else and will reach the hook
 * in time. A trigger that can't nudge now waits.
 */
export const atPrompt = (
  nudges: Nudges,
  input: {
    readonly quiet: boolean
    readonly facts?: Facts | undefined
    /** Whether the terminal has no summary on record. */
    readonly unsummarized?: boolean
    /** Whether an answer with the notices of a `Taken` stays within what a hook may print. */
    readonly fits?: Parameters<typeof take>[2]
  },
): Taken => {
  const counted = personPrompted(nudges)
  const looked = input.facts ? drifted(counted, input.facts) : counted
  return take(input.unsummarized ? fired(looked, "unsummarized") : looked, input.quiet, input.fits)
}

/**
 * The nudge, one line worded as Novadeck's automatic notice: asking for a summary while
 * there is none, at once, before the agent goes on with its work, as the terminal has no
 * title until then; else showing the current one, to update only when the work's subject
 * moved or it holds what a summary leaves out (status, PR or issue numbers, details). A summary names
 * the subject at a high level, as murmur titles the terminal from it.
 */
export const nudgeText = (current: { readonly summary: string | null }) =>
  current.summary === null
    ? "Novadeck: automatic notice, not from the user: this terminal has no summary yet. " +
      "Call Novadeck's summarize tool now, before you go on with the work you were given, " +
      "with one short line on what the work here is about, at a high level: its subject, with " +
      "no status, PR or issue numbers, or details; with no work given yet, do so as soon as " +
      "there is. " +
      "Novadeck titles this terminal from it, and other agents read it in their agents " +
      "listing. This notice needs no reply."
    : `Novadeck: automatic notice, not from the user: this terminal's summary is ` +
      `${JSON.stringify(shorten(current.summary, 200))}; ` +
      "if the work here is now about something else, or that holds status, PR or issue " +
      "numbers, or details, update it with Novadeck's summarize tool to one short line on " +
      "its subject. Progress alone is no reason to update it; otherwise this notice can be " +
      "ignored."

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
  "touches on the way aren't: once a piece of work is done, show the working tree's " +
  "changes with changes, as diffs. Show a deliverable " +
  "with open when you finish it or they asked to see it, so it opens at once; leave open " +
  "off for anything supporting, which waits for them marked new. Showing the same file or page again " +
  "updates it, so one item per deliverable, and while they have it open each save shows " +
  "at once. close takes away what no longer applies, never what they may still be " +
  "looking at unless they asked; showing lists what is there. This notice needs no reply."

/**
 * What a session is told once of the Inbox, with the bar's notice: that the person
 * rarely watches the terminal, so a question the agent's turn ends waiting on goes there:
 * through its harness's own question tool where it would use one, which the Inbox shows
 * as it is, else with `ask` and in the reply in full; that something only they can do (a sign-in, access,
 * a key) is an `ask` with the action shape; that a finished task is reported with `done`;
 * and that with a lead, it uses `ask`, `tell` and `done` all the same and sends the lead its
 * reports and questions too; and that the person writing in the terminal withdraws the
 * agent's open asks. It says so in every harness at the prompt, Antigravity's
 * too, which reads no server instructions (there `ask`'s description is what lasts, as an
 * injection lasts one model call), and again after a compaction where the harness reports
 * one.
 */
export const inboxNotice =
  "Novadeck: automatic notice, not from the user: the user rarely watches this terminal, " +
  "so a question only in your reply goes unseen. When your harness has its own question " +
  "tool and you'd stop to ask with it, do, as you normally would: Novadeck shows that " +
  "question in their Inbox as it is, so it needs no ask. Always put every other question " +
  "you end your turn waiting on, such as which option to take or whether to open a pull " +
  "request, in their Inbox with Novadeck's ask tool, unless it is already an open ask, and put the " +
  "full question in your reply too; a closing offer such as 'anything else?' isn't one, " +
  "nor is an action your harness is already prompting them for. When you can't go on " +
  "without something only the user can do, such as a sign-in, access to a service or " +
  "repo, or a key put in place, that is an ask with the action shape, not just words in " +
  "your reply; never ask for a secret value. When the task you were given is finished, " +
  "report it with Novadeck's done tool, your own short report, not when you answer a " +
  "question or finish a step. With a lead, use ask, tell and done all the same, and send " +
  "your lead your report and your questions too; approvals of actions are still only the " +
  "user's. " +
  "When they write to you here, Novadeck takes your open asks out of their Inbox " +
  "and tells you; ask again only what their message leaves open. If they answer one here " +
  "and no such notice came, withdraw it yourself. This notice needs no reply."

/**
 * What a quiet prompt's answer says for what it `took`: the bar beside the terminal and
 * the Inbox, for a session that begins or forgot, the terminal's description, and each
 * page that had problems, each a paragraph of its own.
 */
export const noticesAt = (
  took: Pick<Taken, "artifacts" | "summarize" | "pages">,
  current: { readonly summary: string | null },
): string =>
  [
    ...(took.artifacts ? [artifactsNotice, inboxNotice] : []),
    ...(took.summarize ? [nudgeText(current)] : []),
    ...took.pages.map(pageNotice),
  ].join("\n\n")
