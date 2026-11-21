import type { AgentName } from "@novadeck/core/harnesses"
import type { ViewMode } from "@novadeck/core/types"

import type { LeadState, TourSignals } from "./signals"

// What the tour marks on the page (`anchors.ts`): the lead's window, the terminal the coach
// names, the teammates' windows, the newest conversation in the lead's Messages, the Inbox row
// waiting on the person, the answers of the request sheet open now, and what the lead shows in
// its side pane.
export type TourTarget =
  | "lead"
  | "terminal"
  | "team"
  | "newest-message"
  | "asking-row"
  | "answers"
  | "shown"

// The tour's four acts, each opened by a wipe with its number and name. A step belongs to one.
export const tourActs = ["Your agent", "The team", "Your call", "The result"] as const
export type TourAct = 1 | 2 | 3 | 4

// What the tour says at a step: the line its caption box letters, beside what it marks, and for
// a moment the person has to act on, a note of what to do, under the box. It marks where to
// look (`look`) apart from what to press (`click`, the first of its targets drawn now).
export type Coach = {
  readonly look?: TourTarget
  readonly click?: readonly TourTarget[]
  // The terminal its `terminal` target means where not the lead's own, as a teammate's.
  readonly terminalId?: string
  readonly line: string
  readonly note?: string
  // Whether its box may lie over windows. A box keeps clear of every window where any free
  // space fits it; one whose step turns the person's eyes away from the windows (to the Inbox,
  // a question's sheet) goes beside what it marks instead, over them if need be.
  readonly overWindows?: boolean
}

// What the tour moves as a step begins, never again: the view, the lead's terminal brought into
// view and selected (in Canvas the camera flies to it), the Inbox, the lead's Messages in its side
// pane, every window framed (Canvas).
export type TourMove =
  | { readonly kind: "view"; readonly view: ViewMode }
  | { readonly kind: "reveal" }
  | { readonly kind: "inbox" }
  | { readonly kind: "messages" }
  | { readonly kind: "fit-all" }

// How a step waits: on the agent (`nudge`: it rings the lead once after the tour's patience,
// and moves on after as long again), or on the person's own doing (`patient`: as long as it
// takes).
export type TourWait = "nudge" | "patient"

// What a run remembers across its signals: whether a teammate's question was seen waiting, so
// its going away is the person's answer.
export type TourMemory = { readonly asked: boolean }

// A step of the tour's story: its act, what it moves as it begins, what it says while it waits,
// the signal that ends it, and how it waits (which may change once the run has seen something).
export type TourStep = {
  readonly id: string
  readonly act: TourAct
  readonly enter: readonly TourMove[]
  // Every window is framed again as the team grows while the step is on, so the camera keeps
  // the new windows in view (Canvas).
  readonly frameTeam?: boolean
  // How long the step stays once done, for the person to look at what it shows, before the
  // run moves on.
  readonly holdMs?: number
  readonly coach: Coach
  readonly done: (signals: TourSignals, memory: TourMemory) => boolean
  readonly wait: TourWait | ((memory: TourMemory) => TourWait)
}

export const waitOf = (step: TourStep, memory: TourMemory): TourWait =>
  typeof step.wait === "function" ? step.wait(memory) : step.wait

// Act 1: in Canvas, a terminal opens and the person's own agent starts there, with its brief,
// and describes itself as the tour's lead.
export const startStep: TourStep = {
  id: "start",
  act: 1,
  enter: [{ kind: "view", view: "canvas" }, { kind: "reveal" }],
  coach: { look: "lead", line: "Your own agent. In a sandbox." },
  // It describes itself, as its brief asks; or, where a cheap model skips that, its first turn
  // ends.
  done: ({ lead }) => lead.kind === "agent" && (lead.named || lead.answered),
  wait: "nudge",
}

// How long a step that's done in moments stays, so its caption box, which shows a second after
// what the step marks, is on screen long enough to read.
const lineMs = 3_000

// Act 2: the lead opens two teammates, which come up on the canvas, wired to it, and name
// themselves; the camera pulls back to frame them all as each comes. Done, it stays a moment
// (`lineMs`), as they name themselves in seconds, for its line to be read.
export const teamStep: TourStep = {
  id: "team",
  act: 2,
  enter: [{ kind: "fit-all" }],
  frameTeam: true,
  holdMs: lineMs,
  coach: { look: "team", line: "It hired two more." },
  done: ({ team }) => team.count >= 2 && team.named >= 2,
  wait: "nudge",
}

// Still act 2: the team talks, as the lead's Messages show: the first message a teammate sends
// is the talk to see (the designer's look, to its lead). That message is what it marks and what
// makes it done, so it stays a moment once done (`lineMs`), for its line to be read.
export const talkStep: TourStep = {
  id: "talk",
  act: 2,
  enter: [{ kind: "fit-all" }, { kind: "messages" }],
  frameTeam: true,
  holdMs: lineMs,
  coach: { look: "newest-message", line: "They talk to each other." },
  done: ({ talks }) => talks >= 1,
  wait: "nudge",
}

// Act 3: a teammate asks the person in the Inbox, and the team carries on with the answer.
// It waits on the agent until the question shows, then on the person, as long as they take.
export const askStep: TourStep = {
  id: "ask",
  act: 3,
  enter: [{ kind: "inbox" }],
  coach: {
    click: ["answers", "asking-row"],
    line: "Your call. They wait on you.",
    overWindows: true,
  },
  done: ({ asking, answered }, { asked }) => answered || (asked && !asking),
  wait: ({ asked }) => (asked ? "patient" : "nudge"),
}

// Act 4: the lead shows the result in the side pane beside its terminal, the team framed with
// it, so the result's caption has room beside the lead. Once it's shown, it stays a few seconds
// (while the tour's project is on screen) to be looked at, then the story ends and the closing
// card comes.
export const showStep: TourStep = {
  id: "show",
  act: 4,
  enter: [{ kind: "fit-all" }],
  holdMs: 6_000,
  coach: { look: "shown", line: "Made for you." },
  done: ({ shown }) => shown,
  wait: "nudge",
}

// The tour's steps, in order: the story the brief asks its agent to play.
export const tourSteps: readonly TourStep[] = [startStep, teamStep, talkStep, askStep, showStep]

// What the tour moves as its story ends: every window framed, for the closing card.
export const closingMoves: readonly TourMove[] = [{ kind: "fit-all" }]

// What the tour says while the lead's agent holds at a screen of its own, whatever the step:
// the person answers it in the agent's terminal, and the tour waits as long as that takes.
export const screenCoach = (
  screen: Extract<LeadState, { kind: "screen" }>["screen"],
  agent: AgentName,
): Coach => ({
  click: ["terminal"],
  line: "It wants an answer first.",
  note:
    screen === "sign-in"
      ? "It needs you to sign in: do it here, in its terminal. The tour goes on once you're in."
      : screen === "hooks"
        ? agent === "codex"
          ? 'Codex asks you to trust Novadeck\'s hooks: pick "Trust all and continue" here, or review them first, and the tour goes on.'
          : "Novadeck's hooks are off for it, so Novadeck can't follow it. Turn hooks back on in its settings, then start it again here."
        : "Answer it here, in its terminal: it's its own question, such as whether to trust the tour's folder. The tour goes on once you have.",
})

// What the tour says while an agent of the team asks the person's permission: it isn't part of
// the story, and the tour waits until they answer.
export const permissionCoach = (terminalId: string): Coach => ({
  click: ["terminal"],
  terminalId,
  line: "It's asking your permission.",
  note: "It wants to do something in the tour's folder. Answer it here, in its terminal, and the tour goes on.",
})

// What the tour says once the lead's agent has stopped: its terminal is still there to read.
export const endedCoach: Coach = {
  click: ["lead"],
  line: "Your agent stopped.",
  note: "Its terminal shows why. Start it again there and the tour goes on, or end the tour.",
}
