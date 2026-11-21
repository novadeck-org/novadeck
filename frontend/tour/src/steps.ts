import type { AgentName } from "@novadeck/core/harnesses"
import type { SidebarPanel, ViewMode } from "@novadeck/core/types"

import type { LeadState, TourSignals } from "./signals"

// What the tour marks on the page (`anchors.ts`): the lead's window, the terminal the coach
// names, the teammates' windows, the New terminal button in the sidebar's Terminals panel, the
// Inbox row waiting on the person, the answers of the request sheet open now, the tour's file in
// the Files panel, and the window that shows its merged preview.
export type TourTarget =
  | "lead"
  | "terminal"
  | "team"
  | "new-terminal"
  | "asking-row"
  | "answers"
  | "file-row"
  | "preview"

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
// view and selected (in Canvas the camera flies to it) with a sidebar panel opened where one is
// named, the Inbox, every window framed (Canvas).
export type TourMove =
  | { readonly kind: "view"; readonly view: ViewMode }
  | { readonly kind: "reveal"; readonly panel?: SidebarPanel }
  | { readonly kind: "inbox" }
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
  coach: { look: "lead", line: "Your own agent. In a sandbox repo." },
  // It describes itself, as its brief asks; or, where a cheap model skips that, its first turn
  // ends.
  done: ({ lead }) => lead.kind === "agent" && (lead.named || lead.answered),
  wait: "nudge",
}

// How long a step that's done in moments stays, so its caption box, which shows a second after
// what the step marks, is on screen long enough to read.
const lineMs = 3_000

// Act 2: the lead opens a fixer for the first bug, which comes up on the canvas, wired to it, and
// names itself; the camera pulls back to frame them as it comes. Done, it stays a moment
// (`lineMs`), as it names itself in seconds, for its line to be read.
export const hireStep: TourStep = {
  id: "hire",
  act: 2,
  enter: [{ kind: "fit-all" }],
  frameTeam: true,
  holdMs: lineMs,
  coach: { look: "team", line: "It put a fixer on bug 1." },
  done: ({ team }) => team.count >= 1 && team.named >= 1,
  wait: "nudge",
}

// Still act 2: the person's own doing. The sidebar's Terminals panel shows its New terminal
// button, which the tour marks; the terminal they open gets their agent, which the driver asks
// the backend for (`tour.fixer`), led by the lead, for the second bug. Done once that terminal
// has joined the team (a teammate the person opened), whatever happens to the lead's own fixer. It waits on the person as long as they take. A backend without `tour.fixer` has no
// such step (`stepsOf`).
export const yoursStep: TourStep = {
  id: "yours",
  act: 2,
  enter: [{ kind: "reveal", panel: "terminals" }, { kind: "fit-all" }],
  coach: {
    click: ["new-terminal"],
    line: "Your turn. Open a terminal.",
    note: "Your agent starts in it and takes bug 2.",
  },
  done: ({ adopted }) => adopted,
  wait: "patient",
}

// Act 3: the person's fixer asks them in the Inbox, and the team carries on with the answer.
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

// Still act 3: with the answer in, the fixers make their fixes, each in its own worktree, and
// the tour looks at the team meanwhile. Done once each has made its fix (its work changes the
// file, or it told the lead so), and it stays a moment then, as they may do it in seconds, for its
// line to be read. With no second fixer (a backend without `tour.fixer`) the one fixes alone.
export const makeStep: TourStep = {
  id: "make",
  act: 3,
  enter: [{ kind: "fit-all" }],
  holdMs: lineMs,
  coach: { look: "team", line: "Now they fix it. Each in its own worktree." },
  done: ({ fixed, team }) => fixed >= 1 && fixed >= Math.min(2, team.count),
  wait: "nudge",
}

// Act 4: the Files panel opens, with the tour's file in it, which the person opens: it shows
// the file as both fixes merge it, in a window of its own. The result's wipe opens the act. Done
// once the file is open in any form, so a backend that opens it as a plain file ends the story too.
export const resultStep: TourStep = {
  id: "result",
  act: 4,
  enter: [{ kind: "reveal", panel: "files" }, { kind: "fit-all" }],
  coach: { click: ["file-row"], line: "Both fixes, merged. Open the file." },
  done: ({ preview }) => preview !== null,
  wait: "patient",
}

// Still act 4: the merged preview, looked at a few seconds (while the tour's project is on
// screen), then the story ends and the closing card comes.
export const mergedStep: TourStep = {
  id: "merged",
  act: 4,
  enter: [],
  holdMs: 6_000,
  coach: { look: "preview", line: "Two agents. One file. Merged live." },
  done: ({ preview }) => preview !== null,
  wait: "patient",
}

// The tour's steps, in order: the story the brief asks its agent to play.
export const tourSteps: readonly TourStep[] = [
  startStep,
  hireStep,
  yoursStep,
  askStep,
  makeStep,
  resultStep,
  mergedStep,
]

// The steps a backend plays: without `tour.fixer` there is no second fixer to start, so the
// person's own step is left out.
export const stepsOf = (hasFixer: boolean): readonly TourStep[] =>
  hasFixer ? tourSteps : tourSteps.filter(({ id }) => id !== yoursStep.id)

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
