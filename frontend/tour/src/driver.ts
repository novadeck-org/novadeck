import type { AgentName } from "@novadeck/core/harnesses"
import { messagesKey, type BarKey } from "@novadeck/core/items/companion-bar"
import type { SidebarPanel, ViewMode } from "@novadeck/core/types"

import type { LeadState, TourRole, TourSignals } from "./signals"
import {
  endedCoach,
  leftCoach,
  nudgeOf,
  permissionCoach,
  screenCoach,
  stepsOf,
  waitOf,
  type Coach,
  type TourMove,
  type TourStep,
} from "./steps"

// A run of the tour as the UI follows it: its lead's terminal and agent, where the lead's first
// line goes (`launch`, or rung once the agent shows: `doorbell`), the command that starts the
// agent (the artist's terminal starts with it too), whether the run has a page to play, the step
// it is at, when that step's wait began (it begins again after a screen of the agent's own),
// whether the waited-on agent was nudged at this step, and whether the lead's first line was
// rung.
export type TourRun = {
  readonly terminalId: string
  readonly agent: AgentName
  readonly brief: "launch" | "doorbell"
  readonly command: string
  readonly page: boolean
  readonly step: number
  readonly waitingSince: number
  readonly nudged: boolean
  readonly briefed: boolean
  // A teammate's question was seen waiting, at any step so far: its going away is the answer,
  // even where the person answered it before its step came.
  readonly asked: boolean
  // The step's moves were made: a step makes them once, as it begins, never again.
  readonly entered: boolean
  // The step's pane tab was opened: it is, once, as soon as the item it shows is there.
  readonly tabbed: boolean
  // When the step on now was done, where it holds a while before the run moves on (`holdMs`);
  // null while it isn't.
  readonly doneAt: number | null
  // When the caption of the step on now was first shown on screen, null while it isn't: a held
  // step holds from then, so its line is read for the full `holdMs` however long the camera, the
  // tab and the caption's own delay took. Not kept through a reload: the caption shows again.
  readonly captionAt: number | null
  // The terminal the tour opened for the artist, once it has: kept, so a reload follows it
  // again and never opens a second.
  readonly artist: string | null
  // Whether the artist's brief was rung.
  readonly artistBriefed: boolean
  // Whether the person declined the lead's run: from then on the run has no page, whatever
  // `page` says. Kept, so a reload doesn't bring the page steps back.
  readonly declined: boolean
  // Whether the artist was dropped from the story: its terminal is gone or ended, or never got
  // its agent up. Kept the same way.
  readonly artistDropped: boolean
  // The lead's run approval was seen waiting, and when it was first seen gone after that (null
  // while it waits): not kept through a reload, which lists approvals anew a moment later.
  readonly approvalSeen: boolean
  readonly approvalGoneAt: number | null
  // When the artist's terminal was first seen with no agent yet, for the step's patience.
  readonly startingSince: number | null
}

// How long after its approval is gone the lead's run is taken as declined: an approved run opens
// its terminal right after, which the signals show as `served`.
export const declineMs = 8_000

// The steps a run plays: with no page once the run was declined, without the artist once it was
// dropped.
export const stepsFor = (run: TourRun, hasArtist: boolean): readonly TourStep[] =>
  stepsOf(run.page && !run.declined, hasArtist && !run.artistDropped)

// What moves the run on: the workspace's signals changing, the clock reaching a wait's end, the
// person ending the tour, the backend refusing to ring the lead's first line or the artist's
// brief, to be tried again, or the artist's terminal opened.
export type TourEvent =
  | { readonly type: "signals"; readonly signals: TourSignals; readonly now: number }
  | { readonly type: "tick"; readonly signals: TourSignals; readonly now: number }
  | {
      readonly type: "caption"
      readonly line: string
      readonly signals: TourSignals
      readonly now: number
    }
  | { readonly type: "end" }
  | { readonly type: "brief-failed" }
  | { readonly type: "artist-opened"; readonly terminalId: string }
  | { readonly type: "artist-brief-failed" }
  | { readonly type: "artist-brief-gave-up"; readonly now: number }

// How a run ended: its story done, the person ended it, or its lead's terminal closed.
export type TourEnd = "done" | "ended" | "gone"

// A move of a step, with the terminal its role is.
export type TourMade =
  | { readonly kind: "view"; readonly view: ViewMode }
  | { readonly kind: "reveal"; readonly terminalId: string; readonly panel?: SidebarPanel }
  | { readonly kind: "inbox" }
  | { readonly kind: "fit-all" }

// What follows from an event: the run as it is now (null once it ended, with why), the moves to
// make as a step begins, the pane tab to open (a terminal's, by its item key), whether to ring
// the lead its first line, the terminal to nudge, and what the artist needs: its terminal
// opened (`open`) or its brief rung (`brief`).
export type TourOutcome = {
  readonly run: TourRun | null
  readonly end?: TourEnd
  readonly moves: readonly TourMade[]
  readonly tab: { readonly terminalId: string; readonly key: BarKey } | null
  readonly brief: boolean
  readonly nudge: string | null
  readonly artist: "open" | "brief" | null
}

export const beginRun = (
  start: {
    readonly terminalId: string
    readonly agent: AgentName
    readonly brief: TourRun["brief"]
    readonly command: string
    readonly page: boolean
  },
  now: number,
): TourRun => ({
  ...start,
  step: 0,
  waitingSince: now,
  nudged: false,
  briefed: start.brief === "launch",
  asked: false,
  entered: false,
  tabbed: false,
  doneAt: null,
  captionAt: null,
  artist: null,
  artistBriefed: false,
  declined: false,
  artistDropped: false,
  approvalSeen: false,
  approvalGoneAt: null,
  startingSince: null,
})

const still = (run: TourRun | null): TourOutcome => ({
  run,
  moves: [],
  tab: null,
  brief: false,
  nudge: null,
  artist: null,
})

// The run at its next step, or ended once its story is done: past its last step, it stays only
// until its lead's first line is rung.
const nextStep = (run: TourRun, steps: readonly TourStep[], now: number): TourOutcome => {
  const step = Math.min(run.step + 1, steps.length)
  if (step === steps.length && run.briefed) return { ...still(null), end: "done" }
  return still({
    ...run,
    step,
    waitingSince: now,
    nudged: false,
    entered: false,
    tabbed: false,
    doneAt: null,
    captionAt: null,
  })
}

// How long a done step waits for its caption to show before its hold counts anyway, so a caption
// that can't show (the machine is slow, the mark never resolves) never stalls the story.
export const captionWaitMs = 8_000

// When a done step's hold ends: `holdMs` after its caption was shown (or after the wait for it
// ran out), never before it was done. A step with no line to read holds from when it was done.
const holdEnd = (run: TourRun, step: TourStep): number | null => {
  if (step.holdMs === undefined || typeof run.doneAt !== "number") return null
  if (step.coach.line === "") return run.doneAt + step.holdMs
  return Math.max(run.doneAt, run.captionAt ?? run.doneAt + captionWaitMs) + step.holdMs
}

// Whether a done step still holds, for the person to look at what it shows.
const holding = (run: TourRun, step: TourStep, now: number): boolean => {
  const end = holdEnd(run, step)
  return step.holdMs !== undefined && (end === null || now < end)
}

// The agent a step waits on, as the signals show it: the artist's for a step on the artist, a
// teammate's for one on the sculptor or the fixer (the lead's while it isn't found or up), the
// lead's otherwise.
const waitedOn = (step: TourStep, signals: TourSignals): LeadState | null => {
  const role = nudgeOf(step, signals)
  if (role === "artist") return signals.artist
  if (role === "sculptor" || role === "fixer") {
    const mate = signals.mates[role]
    if (mate?.kind === "agent") return mate
  }
  return signals.lead
}

// Whether the agent a step waits on stands where its wait counts: there and quiet, not working on
// a turn, nor holding at a screen of its own or a teammate's, nor with an agent asking the
// person's permission, nor stopped. A turn that runs long is no silence.
const counting = (step: TourStep, signals: TourSignals): boolean => {
  const agent = waitedOn(step, signals)
  return (
    agent?.kind === "agent" &&
    !agent.working &&
    signals.teamScreen === null &&
    signals.teamLeft === null &&
    signals.permission === null
  )
}

// The roles a step's moves name, which have to be found before they can be made.
const rolesOf = (step: TourStep): readonly TourRole[] => [
  ...step.enter.flatMap((move) => (move.kind === "reveal" ? [move.role ?? "lead"] : [])),
  ...(step.open ? [step.open.role] : []),
]

// The terminal a role is: the lead's is the run's own, the others are found in the workspace.
const terminalOf = (run: TourRun, signals: TourSignals, role: TourRole): string | undefined =>
  role === "lead" ? run.terminalId : signals.roles[role]

// Whom to nudge where the step's role isn't found: the lead, but never in place of the artist.
const fallbackNudge = (run: TourRun, step: TourStep, signals: TourSignals): string | null =>
  nudgeOf(step, signals) === "artist" ? null : run.terminalId

const resolve = (
  moves: readonly TourMove[],
  run: TourRun,
  signals: TourSignals,
): readonly TourMade[] =>
  moves.flatMap((move): TourMade[] => {
    if (move.kind !== "reveal") return [move]
    const terminalId = terminalOf(run, signals, move.role ?? "lead")
    return terminalId === undefined
      ? []
      : [{ kind: "reveal", terminalId, ...(move.panel && { panel: move.panel }) }]
  })

// A step's beginning: its moves, made once, as it begins on screen with the roles they name
// found; and its pane tab, opened once, as soon as its item is there after that. The artist's
// terminal is asked for once, as its step begins.
const entering = (
  run: TourRun,
  step: TourStep,
  signals: TourSignals,
): Pick<TourOutcome, "moves" | "tab" | "artist"> & { readonly run: TourRun } => {
  const enter =
    !run.entered &&
    signals.onScreen &&
    rolesOf(step).every((role) => terminalOf(run, signals, role))
  const entered = run.entered || enter
  const { open } = step
  const terminalId = open && terminalOf(run, signals, open.role)
  const key: BarKey | null | undefined =
    open && (open.tab === "messages" ? messagesKey : signals.shown[open.tab])
  const tab =
    entered && signals.onScreen && !run.tabbed && terminalId && key ? { terminalId, key } : null
  return {
    run: { ...run, entered, tabbed: run.tabbed || tab !== null },
    moves: enter ? resolve(step.enter, run, signals) : [],
    tab,
    artist: enter && step.opensArtist && run.artist === null ? "open" : null,
  }
}

/**
 * Moves the run on by one event. A step makes its moves once, as it begins, and only while the
 * tour's project is on screen, so the tour never takes the person's view back from them. The
 * lead's first line is rung once its agent shows, where the launch line carried none, and the
 * artist's brief once the agent shows in the terminal the tour opened for it. A step waiting on
 * an agent nudges it once after `patienceMs` of that agent being there, and moves on after as
 * long again; its wait starts over while it holds at a screen of its own. A run ends once its
 * last step is done, the person ends it, or its lead's terminal closes.
 */
export const stepRun = (
  run: TourRun,
  steps: readonly TourStep[],
  event: TourEvent,
  patienceMs: number,
): TourOutcome => {
  switch (event.type) {
    case "end":
      return { ...still(null), end: "ended" }
    case "brief-failed":
      return still({ ...run, briefed: false })
    case "artist-opened":
      return still({ ...run, artist: event.terminalId, artistBriefed: false })
    case "artist-brief-failed":
      return still({ ...run, artistBriefed: false })
    // The artist's brief failed for good: no agent that can't be briefed is waited on or nudged,
    // so it drops out of the story as one whose terminal closed does. It counts as rung, so
    // nothing rings it again.
    case "artist-brief-gave-up": {
      if (run.artistDropped) return still(run)
      const next = { ...run, artistDropped: true, artistBriefed: true }
      const hadArtist = steps.some(({ id }) => id === "outsider")
      return still(reshape(next, steps, hadArtist, steps[run.step]?.id, event.now).run)
    }
    // The step's own caption box came on screen: a held step's hold counts from the first time.
    // A box for any other line (the agent's own screen, a teammate's question) isn't its.
    case "caption": {
      const step = steps[run.step]
      if (
        !step ||
        step.holdMs === undefined ||
        step.coach.line !== event.line ||
        run.captionAt !== null
      )
        return still(run)
      const adjusted = adjust(
        { ...run, captionAt: event.now },
        steps,
        event.signals,
        event.now,
        patienceMs,
      )
      return follow(adjusted.run, adjusted.steps, event.signals, event.now, patienceMs)
    }
    case "signals":
    case "tick": {
      const adjusted = adjust(run, steps, event.signals, event.now, patienceMs)
      return follow(adjusted.run, adjusted.steps, event.signals, event.now, patienceMs)
    }
  }
}

// What the signals say about the story's parts that may drop out, applied before a step is
// followed: the lead's run declined (no page from then on), or the artist gone for good. The
// steps are those of the run as it is now, and its step is kept where its step is still played,
// else moved to the first step after what dropped.
const adjust = (
  run: TourRun,
  steps: readonly TourStep[],
  signals: TourSignals,
  now: number,
  patienceMs: number,
): { readonly run: TourRun; readonly steps: readonly TourStep[] } => {
  let next = run
  if (run.page && !run.declined) {
    if (signals.served) next = { ...next, approvalSeen: false, approvalGoneAt: null }
    else if (signals.approving) next = { ...next, approvalSeen: true, approvalGoneAt: null }
    else if (next.approvalSeen && next.approvalGoneAt === null)
      next = { ...next, approvalGoneAt: now }
    else if (
      next.approvalSeen &&
      next.approvalGoneAt !== null &&
      now - next.approvalGoneAt >= declineMs
    )
      next = { ...next, declined: true }
  }
  const hadArtist = run.artistDropped || steps.some(({ id }) => id === "outsider")
  const here = steps[next.step]?.id
  if (hadArtist && !next.artistDropped && next.artist !== null && here !== "play") {
    const { artist } = signals
    const gone = artist === null || artist.kind === "ended" || artist.kind === "gone"
    if (artist?.kind === "starting" && next.startingSince === null)
      next = { ...next, startingSince: now }
    else if (artist?.kind !== "starting" && next.startingSince !== null)
      next = { ...next, startingSince: null }
    const stuck = next.startingSince !== null && now - next.startingSince >= patienceMs
    if (gone || stuck) next = { ...next, artistDropped: true }
  }
  if (next.declined === run.declined && next.artistDropped === run.artistDropped)
    return { run: next, steps }
  return reshape(next, steps, hadArtist, here, now)
}

// A run whose story lost a part (the page, the artist), at the steps it plays now: its step kept
// where it is still played, else moved to the first step after what dropped.
const reshape = (
  next: TourRun,
  steps: readonly TourStep[],
  hadArtist: boolean,
  here: string | undefined,
  now: number,
): { readonly run: TourRun; readonly steps: readonly TourStep[] } => {
  const played = stepsFor(next, hadArtist)
  const index = played.findIndex(({ id }) => id === here)
  if (index >= 0) return { run: { ...next, step: index }, steps: played }
  // Its step dropped: on to the first the story still plays after it.
  const after = here === "run" || here === "page" ? "shape" : "play"
  return {
    run: {
      ...next,
      step: played.findIndex(({ id }) => id === after),
      waitingSince: now,
      nudged: false,
      entered: false,
      tabbed: false,
      doneAt: null,
      captionAt: null,
    },
    steps: played,
  }
}

const follow = (
  run: TourRun,
  steps: readonly TourStep[],
  signals: TourSignals,
  now: number,
  patienceMs: number,
): TourOutcome => {
  if (signals.lead.kind === "gone") return { ...still(null), end: "gone" }
  const brief = !run.briefed && signals.lead.kind === "agent"
  const ring = run.artist !== null && !run.artistBriefed && signals.artist?.kind === "agent"
  const seen = {
    ...run,
    asked: run.asked || signals.asking,
    artistBriefed: run.artistBriefed || ring,
  }
  const briefed = brief ? { ...seen, briefed: true } : seen
  const rung = ring ? "brief" : null
  const step = steps[run.step]
  // Past its story: it ends once its first line was rung, at the event after, so a ring the
  // backend refused is tried again first.
  if (!step)
    return brief || !run.briefed
      ? { ...still(briefed), brief, artist: rung }
      : { ...still(null), end: "done" }
  // Done: on to the next step, which begins with these same signals at once (its moves made
  // now, not at some later change), but never ended in the event that rings its first line.
  if (typeof run.doneAt === "number" || step.done(signals, briefed)) {
    // A step that holds stays, its coach still said and its moves made, until its time is up.
    // Its time counts only while the tour's project is on screen: away, it starts over, so the
    // person sees what it holds on, and the story never ends in another project.
    if (holding(briefed, step, now) || (step.holdMs !== undefined && !signals.onScreen)) {
      const begun = entering(briefed, step, signals)
      const held = {
        ...begun.run,
        doneAt: typeof briefed.doneAt === "number" && signals.onScreen ? briefed.doneAt : now,
        // Away, its caption isn't on screen: it is waited for again.
        captionAt: signals.onScreen ? briefed.captionAt : null,
      }
      return { ...begun, run: held, brief, nudge: null, artist: begun.artist ?? rung }
    }
    const next = nextStep(brief ? seen : briefed, steps, now)
    const following = next.run && { ...next.run, briefed: briefed.briefed }
    if (!following || following.step >= steps.length)
      return { ...next, run: following, brief, artist: rung }
    const begun = follow(following, steps, signals, now, patienceMs)
    return { ...begun, brief: brief || begun.brief, artist: begun.artist ?? rung }
  }
  // Its moves once, as it begins on screen, whatever the agent is doing.
  const begun = entering(briefed, step, signals)
  const entered = begun.run
  const outcome = { ...begun, brief, nudge: null, artist: begun.artist ?? rung }
  // No agent there yet, or a screen of its own: the wait starts over once it counts. A wait on
  // the person has no end of its own.
  if (!counting(step, signals) || waitOf(step, entered, signals) !== "nudge") {
    const waiting = entered.waitingSince === now ? entered : { ...entered, waitingSince: now }
    return { ...outcome, run: waiting }
  }
  const waited = now - run.waitingSince
  if (!run.nudged && waited >= patienceMs)
    return {
      ...outcome,
      run: { ...entered, nudged: true, waitingSince: now },
      nudge: terminalOf(run, signals, nudgeOf(step, signals)) ?? fallbackNudge(run, step, signals),
    }
  if (run.nudged && waited >= patienceMs)
    return { ...nextStep(entered, steps, now), brief, artist: outcome.artist }
  return { ...outcome, run: entered }
}

// When the clock next matters to the run, as epoch ms: its wait's end, for a step waiting on an
// agent while it is there; none otherwise.
export const nextTick = (
  run: TourRun,
  steps: readonly TourStep[],
  signals: TourSignals,
  patienceMs: number,
): number | null => {
  const step = steps[run.step]
  const times: number[] = []
  const end = step && holdEnd(run, step)
  if (typeof end === "number") times.push(end)
  else if (step && waitOf(step, run, signals) === "nudge" && counting(step, signals))
    times.push(run.waitingSince + patienceMs)
  // The decline of the lead's run, and the artist's agent that never came up.
  if (run.approvalGoneAt !== null && !run.declined) times.push(run.approvalGoneAt + declineMs)
  if (run.startingSince !== null && !run.artistDropped) times.push(run.startingSince + patienceMs)
  return times.length > 0 ? Math.min(...times) : null
}

// The harness a program is, by its name.
const agentOfProgram = (program: string | null): AgentName | undefined =>
  program === "claude" || program === "codex" || program === "agy" ? program : undefined

// What the tour says now: a screen of the agent's own, or its stopping, comes first, whatever
// the step.
export const coachNow = (
  run: TourRun,
  steps: readonly TourStep[],
  signals: TourSignals,
): Coach | null => {
  const { lead } = signals
  if (lead.kind === "screen") return screenCoach(lead.screen, run.agent)
  if (lead.kind === "ended") return endedCoach
  if (lead.kind === "left") return leftCoach(undefined)
  // A teammate's or the artist's own screen, as its harness's own question (folder trust,
  // sign-in): the person answers it in that terminal, which the tour points at.
  const held = signals.teamScreen
  if (held) {
    const agent = agentOfProgram(held.program) ?? run.agent
    return {
      ...screenCoach(held.screen, agent),
      line:
        held.terminalId === signals.roles.artist
          ? "The other agent wants an answer first."
          : "A teammate wants an answer first.",
      terminalId: held.terminalId,
    }
  }
  // A teammate's or the artist's program ended, its shell back.
  if (signals.teamLeft) return leftCoach(signals.teamLeft.terminalId)
  // An agent of the team asking the person's permission (its harness's own dialog): they answer
  // it in the Inbox or in that agent's terminal, which the tour points at.
  if (signals.permission) return permissionCoach(signals.permission.terminalId)
  return steps[run.step]?.coach ?? null
}
