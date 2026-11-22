import type { AgentName } from "@novadeck/core/harnesses"

import type { TourSignals } from "./signals"
import {
  endedCoach,
  permissionCoach,
  screenCoach,
  waitOf,
  type Coach,
  type TourMove,
  type TourStep,
} from "./steps"

// A run of the tour as the UI follows it: its lead's terminal and agent, where the lead's first
// line goes (`launch`, or rung once the agent shows: `doorbell`), the step it is at, when that
// step's wait began (it begins again after a screen of the agent's own), whether the lead was
// nudged at this step, and whether its first line was rung.
export type TourRun = {
  readonly terminalId: string
  readonly agent: AgentName
  readonly brief: "launch" | "doorbell"
  readonly step: number
  readonly waitingSince: number
  readonly nudged: boolean
  readonly briefed: boolean
  // A teammate's question was seen waiting, at any step so far: its going away is the answer,
  // even where the person answered it before its step came.
  readonly asked: boolean
  // The step's moves were made: a step makes them once, as it begins, never again.
  readonly entered: boolean
  // When the step on now was done, where it holds a while before the run moves on (`holdMs`);
  // null while it isn't, as in a run kept from before holds were (read as null).
  readonly doneAt: number | null
  // When the run reached the result step, from which the person's opening of the tour's file as
  // a plain window counts (`TourSources.openedAfter`); absent before it.
  readonly fileAfter?: number
}

// What moves the run on: the workspace's signals changing, the clock reaching a wait's end, the
// person ending the tour, or the backend refusing to ring the lead's first line, to be tried
// again.
export type TourEvent =
  | { readonly type: "signals"; readonly signals: TourSignals; readonly now: number }
  | { readonly type: "tick"; readonly signals: TourSignals; readonly now: number }
  | { readonly type: "end" }
  | { readonly type: "brief-failed" }

// How a run ended: its story done, the person ended it, or its lead's terminal closed.
export type TourEnd = "done" | "ended" | "gone"

// What follows from an event: the run as it is now (null once it ended, with why), the moves to
// make as a step begins, and whether to ring the lead its first line or a nudge.
export type TourOutcome = {
  readonly run: TourRun | null
  readonly end?: TourEnd
  readonly moves: readonly TourMove[]
  readonly brief: boolean
  readonly nudge: boolean
}

export const beginRun = (
  start: {
    readonly terminalId: string
    readonly agent: AgentName
    readonly brief: TourRun["brief"]
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
  doneAt: null,
})

const still = (run: TourRun | null): TourOutcome => ({ run, moves: [], brief: false, nudge: false })

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
    doneAt: null,
    ...(steps[step]?.id === "result" && { fileAfter: now }),
  })
}

// Whether a done step still holds, for the person to look at what it shows.
const holding = (run: TourRun, step: TourStep, now: number): boolean =>
  step.holdMs !== undefined && (typeof run.doneAt !== "number" || now - run.doneAt < step.holdMs)

// Whether the lead stands where a step's wait counts: its agent there and quiet, not working on
// a turn, nor holding at a screen of its own or a teammate's, nor with an agent of the team
// asking the person's permission, nor stopped. A turn that runs long is no silence.
const counting = (signals: TourSignals): boolean =>
  signals.lead.kind === "agent" &&
  !signals.lead.working &&
  signals.teamScreen === null &&
  signals.permission === null

/**
 * Moves the run on by one event. A step makes its moves once, as it begins, and only while the
 * tour's project is on screen, so the tour never takes the person's view back from them. Its first line is rung once the agent shows, where the launch line
 * carried none. A step waiting on the agent nudges it once after `patienceMs` of its agent being
 * there, and moves on after as long again; its wait starts over while the agent holds at a
 * screen of its own. A run ends once its last step is done, the person ends it, or its lead's
 * terminal closes.
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
    case "signals":
    case "tick":
      return follow(run, steps, event.signals, event.now, patienceMs)
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
  const seen = signals.asking && !run.asked ? { ...run, asked: true } : run
  const briefed = brief ? { ...seen, briefed: true } : seen
  const step = steps[run.step]
  // Past its story: it ends once its first line was rung, at the event after, so a ring the
  // backend refused is tried again first.
  if (!step)
    return brief || !run.briefed ? { ...still(briefed), brief } : { ...still(null), end: "done" }
  // Done: on to the next step, which begins with these same signals at once (its moves made
  // now, not at some later change), but never ended in the event that rings its first line.
  if (typeof run.doneAt === "number" || step.done(signals, briefed)) {
    // A step that holds stays, its coach still said and its moves made, until its time is up.
    // Its time counts only while the tour's project is on screen: away, it starts over, so the
    // person sees what it holds on, and the story never ends in another project.
    if (holding(briefed, step, now) || (step.holdMs !== undefined && !signals.onScreen)) {
      const enter = !briefed.entered && signals.onScreen
      const held = {
        ...briefed,
        entered: briefed.entered || enter,
        doneAt: typeof briefed.doneAt === "number" && signals.onScreen ? briefed.doneAt : now,
      }
      return { run: held, moves: enter ? step.enter : [], brief, nudge: false }
    }
    const next = nextStep(brief ? seen : briefed, steps, now)
    const following = next.run && { ...next.run, briefed: briefed.briefed }
    if (!following || following.step >= steps.length) return { ...next, run: following, brief }
    const begun = follow(following, steps, signals, now, patienceMs)
    return { ...begun, brief: brief || begun.brief }
  }
  // Its moves once, as it begins on screen, whatever the agent is doing.
  const enter = !run.entered && signals.onScreen
  const entered = enter ? { ...briefed, entered: true } : briefed
  const moves = enter ? step.enter : []
  // No agent there yet, or a screen of its own: the wait starts over once it counts. A wait on
  // the person has no end of its own.
  if (!counting(signals) || waitOf(step, entered) !== "nudge") {
    const waiting = entered.waitingSince === now ? entered : { ...entered, waitingSince: now }
    return { run: waiting, moves, brief, nudge: false }
  }
  const waited = now - run.waitingSince
  if (!run.nudged && waited >= patienceMs)
    return { run: { ...entered, nudged: true, waitingSince: now }, moves, brief, nudge: true }
  if (run.nudged && waited >= patienceMs) return { ...nextStep(entered, steps, now), brief }
  return { run: entered, moves, brief, nudge: false }
}

// When the clock next matters to the run, as epoch ms: its wait's end, for a step waiting on its
// agent while it is there; none otherwise.
export const nextTick = (
  run: TourRun,
  steps: readonly TourStep[],
  signals: TourSignals,
  patienceMs: number,
): number | null => {
  const step = steps[run.step]
  if (step?.holdMs !== undefined && typeof run.doneAt === "number") return run.doneAt + step.holdMs
  if (!step || waitOf(step, run) !== "nudge" || !counting(signals)) return null
  return run.waitingSince + patienceMs
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
  // A teammate's own screen, as its harness's own question (folder trust, sign-in): the person answers
  // it in that teammate's terminal, which the tour points at.
  const held = signals.teamScreen
  if (held) {
    const agent = agentOfProgram(held.program) ?? run.agent
    return {
      ...screenCoach(held.screen, agent),
      line: "A teammate wants an answer first.",
      terminalId: held.terminalId,
    }
  }
  // An agent of the team asking the person's permission (its harness's own dialog): they answer
  // it in the Inbox or in that agent's terminal, which the tour points at.
  if (signals.permission) return permissionCoach(signals.permission.terminalId)
  return steps[run.step]?.coach ?? null
}
