import { digestOf } from "../messaging/messages.js"
import { noticeText } from "../messaging/notice-format.js"
import { shorten } from "../text.js"
import { due, noTroubles, pageNotice, spend, type PageEntry, type Troubles } from "./troubles.js"

/**
 * When Novadeck nudges a terminal's agent to describe its work (see
 * docs/agent-messaging.md, "Naming"): a new root session; a compaction, where the harness
 * reports one; the work drifting from where it was at the last `describe` (its plan's
 * title, the folder it writes in most, or its branch); as a backstop, `backstopPrompts` of
 * the person's prompts since the last `describe`; and every prompt while the terminal has
 * no summary or no title of its own (`unsummarized`), since an agent whose first prompt gave it no work yet
 * puts the first nudge off, and the terminal has no title of its own until it describes.
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
 * A terminal's nudges: the triggers that fired since the last `describe` or nudge, the
 * person's prompts counted toward the backstop, the facts at the last `describe` (null
 * before any), and those drift last fired for; and, apart from all of these, whether
 * the session has yet to hear of the companion bar beside its terminal
 * (`companionNotice`) and of the Inbox (`inboxNotice`), which only their delivery
 * clears, never a `describe`; and the troubles the pane told of pages the session
 * showed (`troubles.ts`), which a new root session drops and only their delivery
 * otherwise clears.
 */
export type Nudges = {
  readonly pending: readonly Trigger[]
  readonly prompts: number
  readonly baseline: Facts | null
  readonly driftedTo: Facts | null
  readonly companion: boolean
  readonly troubles: Troubles
  /** When the current root session began, in milliseconds; only later shows are told of. */
  readonly since: number
  /**
   * Whether drift takes the facts it next reads as its baseline, with no `describe` since
   * the session came back (`sessionResumed`): its baseline went with the runner before.
   */
  readonly reseed?: boolean
}

/** How many of the person's prompts since the last `describe` nudge as a backstop. */
export const backstopPrompts = 5

export const noNudges: Nudges = {
  pending: [],
  prompts: 0,
  baseline: null,
  driftedTo: null,
  companion: false,
  troubles: noTroubles,
  since: 0,
}

/**
 * The triggers at which a session hears of its bar: when it begins, and when it lost its
 * context.
 */
const companionTriggers: ReadonlySet<Trigger> = new Set(["session", "compaction"])

const raised = (nudges: Nudges, trigger: Trigger): Nudges => ({
  ...nudges,
  pending: nudges.pending.includes(trigger) ? nudges.pending : [...nudges.pending, trigger],
  companion: nudges.companion || companionTriggers.has(trigger),
})

/**
 * A trigger fired; it nudges once, at the next turn start with room for it. A
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

/**
 * The root session came back holding what it was told, as resumed after a restart: like
 * `sessionBegan`, only later shows count, but it has nothing to hear again.
 */
export const sessionResumed = (nudges: Nudges, at: number): Nudges => ({
  ...nudges,
  troubles: noTroubles,
  since: at,
  reseed: nudges.baseline === null,
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
 * `describe` and from those it last fired for, so work going back and forth between two
 * folders fires once, not at each turn. Nothing drifts before a `describe`, or before a
 * session resumed after a restart takes the facts it is first read at (`reseed`).
 */
export const drifted = (nudges: Nudges, facts: Facts): Nudges => {
  const { baseline, driftedTo } = nudges
  // A session resumed with no baseline measures drift from the facts it is first read at.
  if (!baseline && nudges.reseed) return { ...nudges, baseline: facts, reseed: false }
  if (!baseline || !differs(baseline, facts)) return nudges
  if (driftedTo && !differs(driftedTo, facts)) return nudges
  return fired({ ...nudges, driftedTo: facts }, "drift")
}

/**
 * The agent described its work: no describe trigger is pending, and drift is measured
 * from `facts`. What the session has yet to hear of its bar stays.
 */
export const afterSummary = (nudges: Nudges, facts: Facts): Nudges => ({
  pending: [],
  prompts: 0,
  baseline: facts,
  driftedTo: null,
  companion: nudges.companion,
  troubles: nudges.troubles,
  since: nudges.since,
})

/** What a turn's answer says, if anything: of the bar and Inbox, of the description, of worktrees, of pages, or all. */
export type Taken = {
  readonly nudge: boolean
  readonly companion: boolean
  readonly summarize: boolean
  /** The worktrees notice it carries: the setting went on, or off. Null for none. */
  readonly worktrees: Worktrees | null
  /** The pages it tells of, each once for its show. */
  readonly pages: readonly PageEntry[]
  readonly nudges: Nudges
}

/** What a notice is, to measure it: a `Taken` without the nudges it leaves. */
export type Noticed = Pick<Taken, "companion" | "summarize" | "pages"> & {
  readonly worktrees?: Worktrees | null
}

/** Whether an answer with the notices of a `Taken` stays within what a hook may print. */
export type Fits = (took: Noticed) => boolean

/**
 * Whether a turn's answer nudges, and with what, and the nudges after it: only when a
 * trigger fired, the bar is yet to be told of or a page has troubles to tell, and only in
 * an answer that will reach the hook `inTime`. The notices share the answer with what it
 * already says, as messages: each goes only as far as `fits` accepts the answer, in turn
 * the summary's request (short, and it asks for something), the bar's and the Inbox's,
 * then the worktrees', then pages; what doesn't fit waits for the next turn. `worktrees` is
 * the worktrees notice due (`worktreesDue`), which isn't part of `Nudges`: the setting's
 * state is told by the session's `told`. `fitsAlone` measures a notice as the only thing
 * an answer says, so a page that could never fit is let go.
 */
export const take = (
  nudges: Nudges,
  inTime: boolean,
  fits: Fits = () => true,
  fitsAlone: Fits = fits,
  worktrees: Worktrees | null = null,
): Taken => {
  const owed = nudges.pending.length > 0
  const silent = {
    nudge: false,
    companion: false,
    summarize: false,
    worktrees: null,
    pages: [],
    nudges,
  }
  if (!inTime || !(owed || nudges.companion || worktrees || due(nudges.troubles))) return silent
  const summarize = owed && fits({ companion: false, summarize: true, pages: [] })
  const companion = nudges.companion && fits({ companion: true, summarize, pages: [] })
  const worded = worktrees !== null && fits({ companion, summarize, worktrees, pages: [] })
  const kept = worded ? worktrees : null
  const { pages, troubles } = spend(
    nudges.troubles,
    (each) => fits({ companion, summarize, worktrees: kept, pages: each }),
    (page) => fitsAlone({ companion: false, summarize: false, pages: [page] }),
  )
  if (!summarize && !companion && !kept && pages.length === 0)
    return { ...silent, nudges: { ...nudges, troubles } }
  return {
    nudge: true,
    companion,
    summarize,
    worktrees: kept,
    pages,
    nudges: {
      ...nudges,
      pending: summarize ? [] : nudges.pending,
      companion: companion ? false : nudges.companion,
      troubles,
    },
  }
}

/**
 * A root turn began, by the person's prompt (`person`) or by the doorbell: a prompt of the
 * person's counts toward the backstop, drift is looked at where `facts` were read, a
 * summary is asked for again while there is none, and the answer nudges as `take` says.
 * A trigger that can't nudge now waits.
 */
export const atTurnStart = (
  nudges: Nudges,
  input: {
    readonly person: boolean
    readonly inTime: boolean
    readonly facts?: Facts | undefined
    /** Whether the terminal has no summary, or no title of its own, on record. */
    readonly unsummarized?: boolean
    readonly fits?: Fits
    readonly fitsAlone?: Fits
    /** The worktrees notice due at this turn, if any (`worktreesDue`). */
    readonly worktrees?: Worktrees | null
  },
): Taken => {
  const counted = input.person ? personPrompted(nudges) : nudges
  const looked = input.facts ? drifted(counted, input.facts) : counted
  return take(
    input.unsummarized ? fired(looked, "unsummarized") : looked,
    input.inTime,
    input.fits,
    input.fitsAlone,
    input.worktrees ?? null,
  )
}

// The describe notice's instruction, which its first two forms share.
const describeNow = (lead: string): string =>
  `${lead}each one short line on what the work here is about, at a high level: its subject, ` +
  "with no status, PR or issue numbers, or details."

/**
 * The nudge, worded as Novadeck's notice of the Describe kind: asking for a title and a
 * summary while there is no summary, at once, before the agent goes on with its work, as
 * the terminal has no title of the agent's until then, and to let the notice be while no
 * work was given, as it comes with every prompt until then (an agent only chatting made up
 * a placeholder to quiet it); else showing the current summary, to update both only when
 * the work's subject moved or the summary holds what it leaves out (status, PR or issue
 * numbers, details). Both name the subject at a high level: the title is what Novadeck
 * names the terminal with when nothing else has, and murmur titles it from the summary.
 */
export const nudgeText = (current: {
  readonly summary: string | null
  readonly title: string | null
}) =>
  current.summary === null
    ? noticeText("Describe", {
        facts:
          "This terminal has no summary yet. Novadeck names this terminal with the title when " +
          "nothing else has, and other agents read the summary in their agents listing.",
        actions: [
          describeNow(
            "Once you've been given work, any task, investigation, review, design discussion or " +
              "question you'll dig into, call Novadeck's describe tool now, before you go on with " +
              "it, with a title and a summary, ",
          ),
          "Until then, such as with only a greeting or a quick question you answer at once, let " +
            "this notice be and make up no title or summary to quiet it: it comes with each " +
            "prompt until you describe.",
        ],
      })
    : current.title === null
      ? // A summary kept from before agents gave titles: the title is all that is missing.
        noticeText("Describe", {
          facts:
            `This terminal's summary is ${JSON.stringify(shorten(current.summary, 200))}, but it ` +
            "has no title yet. Novadeck names this terminal with the title when nothing else " +
            "has. It comes with each prompt until you describe.",
          actions: [
            describeNow(
              "Call Novadeck's describe tool now, before you go on, with a title and a summary, ",
            ),
          ],
        })
      : noticeText("Describe", {
          facts:
            `This terminal's title is ${JSON.stringify(shorten(current.title, 80))} and its ` +
            `summary is ${JSON.stringify(shorten(current.summary, 200))}.`,
          actions: [
            "If the work here is now about something else, or that holds status, PR or issue " +
              "numbers, or details, update them with Novadeck's describe tool, a title and a " +
              "summary, each one short line on its subject. Progress alone is no reason to " +
              "update them.",
          ],
        })

/**
 * What a session is told once of the bar beside its terminal (see docs/agent-workspace.md,
 * "Companion pane"): what to show there and what not to, since an agent left to itself
 * shows nothing until asked, or every file it touches once asked. Worded as Novadeck's
 * notice of the Show kind; independent of `describe`.
 */
export const companionNotice = noticeText("Show", {
  facts:
    "Beside this terminal is a bar where you show the user what the task makes, with " +
    "Novadeck's show tool.",
  actions: [
    "Show a deliverable, a file or page the task itself calls for that your reply can't carry, " +
      "when it is done, not each file you touch: an image or screenshot, a rendered video, " +
      "recording or screen capture, a rendered page or a dev server's address, a mockup or " +
      "diagram, a rendered document such as a PDF, the one file the user asked you for, or an " +
      "existing file or page, or the working tree's changes, that they ask to see.",
    "Show a page you serve or just deployed, such as a dev server or a preview; a link to " +
      "someone else's site, which often wants a sign-in in the pane, goes in your reply unless " +
      "they ask to see it there.",
    "A source file is one too while it is the file you are working on together, so show it and " +
      "keep it shown; the files a change touches on the way aren't: to show a change, show the " +
      "working tree's changes with changes, as diffs.",
    "Show a deliverable with open when you finish it or they asked to see it, so it opens at " +
      "once; leave open off for anything supporting, which waits for them marked new.",
    "Showing the same file or page again updates it, so one item per deliverable, and while " +
      "they have it open each save shows at once.",
    "close takes away what no longer applies, never what they may still be looking at unless " +
      "they asked; showing lists what is there.",
  ],
})

/**
 * What a session is told once of the Inbox, with the bar's notice: that the Inbox shows
 * the person a copy when they're away from the terminal, so a question the agent's turn
 * ends waiting on goes there:
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
export const inboxNotice = noticeText("Inbox", {
  facts:
    "The user's Inbox gets a copy of your questions and reports for when they're away from " +
    "this terminal.",
  actions: [
    "Make every question your turn ends waiting on (which option to take, say) an ask too, " +
      "whether or not they're here, unless it's already an open ask. Not a closing offer like " +
      '"anything else?", an action your harness already prompts them for, or a question you ' +
      "ask with your harness's own question tool as you normally would: Novadeck shows that " +
      "one as it is.",
    "Something only the user can do (a sign-in, access to a service or repo, a key put in " +
      "place) is an ask with the action shape. Never ask for a secret value.",
    "When the task you were given is finished, report it with done, your own short report; " +
      "not when you answer a question or finish a step.",
    "With a lead, use ask, tell and done all the same, and send your lead your report and " +
      "questions too. Approvals of actions are still only the user's.",
    "What you put in the Inbox is an extra copy, never the thing itself: your reply says it " +
      "all as fully as it would without Novadeck, and never mentions the Inbox or what you " +
      "put there.",
    "When the user writes to you here, Novadeck takes your open asks out of their Inbox and " +
      "tells you; ask again only what their message leaves open. If they answer one here and " +
      "no such notice came, withdraw it yourself.",
  ],
})

/**
 * What a session is told of agent worktrees (see docs/agent-messaging.md,
 * "Nudges") while the runner setting `worktrees` is on: that its changes go in a worktree it
 * opens or takes with Novadeck's tools, not in its terminal's checkout, and that the person's
 * own words decide otherwise (told to work in place, or in a folder, it does). That is the
 * default stated plainly (a first version that said "by default" and offered the tools made
 * Claude edit in place in a plain fix, 0 of 1 against 1 of 1 for "Before you change any
 * file", so the default is said, and the person's words are the one way out); the rest is
 * facts and tools, and it prescribes nothing about the work itself. It says nothing of committing, merging or pull requests: some
 * sandboxes (Codex's workspace-write) can't commit, and what to do with the work is the
 * person's to say. It names absolute paths and `git -C` for no harness-specific reason; the
 * instruction files are named because none is loaded from there.
 */
export const worktreesOnNotice = noticeText("Worktrees", {
  facts:
    "Agent worktrees are on: this terminal's changes go in a worktree, not in its checkout, " +
    "unless the user's own words say otherwise (told to work in place, or in a given folder, " +
    "you do). A worktree's home is the branch its work belongs on: the branch it started " +
    "from, or the one you give as home; Novadeck shows it merged once home holds its work.",
  actions: [
    "Before you change a file, open a worktree with open_worktree, or take an existing one " +
      "with take_worktree; one for each repository you change.",
    "Name branches as the repository's own instructions say.",
    "In a worktree, use absolute paths and git -C <worktree> for git rather than cd.",
    "The worktree's instruction files (AGENTS.md, CLAUDE.md and the like) aren't loaded from " +
      "there; open_worktree lists them.",
    "give_worktree hands a worktree to whoever continues the work; close_worktree removes one " +
      "that's merged or abandoned.",
  ],
})

/**
 * What a session whose terminal's folder is in no git repository hears while the setting is
 * on, instead of the on notice. It says the fact and leaves the rest to the tools: a worktree
 * is a repository's, so there's none to open here and a refusal loop is no use. It is said
 * rather than left out because the session still sees the worktree tools, a terminal's folder
 * changes (a `cd` into a repository is told as the on notice, by its digest), and a project may
 * mix repositories with plain folders: `repo` reaches a repository elsewhere.
 */
export const worktreesGitlessNotice = noticeText("Worktrees", {
  facts:
    "Agent worktrees are on, but this terminal's folder isn't in a git repository, so there's " +
    "no worktree to make of it: files here are changed in place. For a repository elsewhere, " +
    "open_worktree takes a folder in it as repo.",
})

/** What a session that was told of worktrees hears when the setting goes off. */
export const worktreesOffNotice = noticeText("Worktrees", {
  facts: "Agent worktrees are off now. Worktrees you already have stay as they are.",
  actions: ["Work in your terminal's own checkout."],
})

/**
 * What a session that started before the worktrees folder existed hears while the setting
 * is on: its harness was launched without the folder as an added directory (the shims pass
 * it only if it exists then), so it can't write there until its process restarts.
 */
export const worktreesEarlyNotice = noticeText("Worktrees", {
  facts:
    "Agent worktrees are on, but this session started before they could be used (its process " +
    "began before the worktrees folder was there or before they were turned on, so it can't " +
    "write in them or has no worktree tools). Until it restarts, its changes go in the " +
    "terminal's own checkout.",
  actions: [
    "Restarting the agent (exit and resume it, or start a new one) lets it use worktrees; " +
      "/clear doesn't.",
  ],
})

/**
 * Which worktrees notice is due: the setting is on (`on`), or on while the terminal's folder
 * is in no git repository (`gitless`), or on for a session that can't use them yet (`early`),
 * or went off after the session heard it on (`off`).
 */
export type Worktrees = "on" | "gitless" | "early" | "off"

/** The digest of each worktrees notice as worded now, kept in `told.worktrees` once told. */
export const worktreesDigests: { readonly [state in Worktrees]: string } = {
  on: digestOf(worktreesOnNotice),
  gitless: digestOf(worktreesGitlessNotice),
  early: digestOf(worktreesEarlyNotice),
  off: digestOf(worktreesOffNotice),
}

/**
 * The worktrees notice a root turn's start owes, given the setting as it reads now and
 * what the session was told (`told.worktrees`). On, a session that holds what a hook
 * printed (`lasting`) is told once: when it begins, when a compaction took the notice
 * (`told` is then empty), or when the setting flipped on or the wording changed since,
 * across a runner restart too. One that doesn't hold it (Antigravity's) is told at each
 * turn. Off, only a session that was told it is on hears so, once. A session whose agent
 * process started before the folder did (`ready` false) hears the early notice in the
 * same way instead, and the on notice once its process restarts. One whose terminal's folder
 * is in no git repository (`inRepository` false) hears the gitless one in the on notice's
 * place, and the on notice when its folder is in one.
 */
export const worktreesDue = (
  enabled: boolean,
  told: string | undefined,
  lasting: boolean,
  ready = true,
  inRepository = true,
): Worktrees | null => {
  if (!enabled) return told === worktreesDigests.on ? "off" : null
  const state = !ready ? "early" : inRepository ? "on" : "gitless"
  return !lasting || told !== worktreesDigests[state] ? state : null
}

/**
 * What a turn's notices say for what it `took`: the bar beside the terminal and
 * the Inbox, for a session that begins or forgot, the terminal's description, agent
 * worktrees, and each page that had problems, each a notice of its own, a blank line apart.
 */
export const noticesAt = (
  took: Noticed,
  current: { readonly summary: string | null; readonly title: string | null },
): string =>
  [
    ...(took.companion ? [companionNotice, inboxNotice] : []),
    ...(took.summarize ? [nudgeText(current)] : []),
    ...(took.worktrees === "on" ? [worktreesOnNotice] : []),
    ...(took.worktrees === "gitless" ? [worktreesGitlessNotice] : []),
    ...(took.worktrees === "early" ? [worktreesEarlyNotice] : []),
    ...(took.worktrees === "off" ? [worktreesOffNotice] : []),
    ...took.pages.map(pageNotice),
  ].join("\n\n")

/**
 * The digest of the bar's and the Inbox's notices as worded now: a session told them in
 * another wording, as before an upgrade, is told again.
 */
export const barDigest = digestOf(`${companionNotice}\n\n${inboxNotice}`)
