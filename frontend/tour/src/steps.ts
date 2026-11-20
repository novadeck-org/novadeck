import type { AgentName } from "@novadeck/core/harnesses"
import type { SidebarPanel, ViewMode } from "@novadeck/core/types"

import type { LeadState, TourSignals } from "./signals"

// The places the tour points at, each a `data-tour` mark in the page (one name may mark a few
// elements; the spotlight takes the first shown). `terminal` is the lead's own terminal.
export type TourAnchor =
  | "terminal"
  | "tabs"
  | "terminals"
  | "messages"
  | "inbox"
  | "inbox-card"
  | "views"
  | "side-pane"

// What the tour says at a step: where it points (none: it floats in a corner), a heading and a
// line or two.
export type Coach = {
  readonly anchor: TourAnchor | null
  // The terminal its `terminal` anchor means where not the lead's own, as a teammate's.
  readonly terminalId?: string
  readonly title: string
  readonly body: string
}

// What the tour moves as a step begins, never again: the view, the lead's terminal brought into
// view and selected (in Canvas the camera flies to it), a sidebar panel, the Inbox, the lead's
// Messages in its side pane, every window framed (Canvas).
export type TourMove =
  | { readonly kind: "view"; readonly view: ViewMode }
  | { readonly kind: "reveal" }
  | { readonly kind: "sidebar"; readonly panel: SidebarPanel }
  | { readonly kind: "inbox" }
  | { readonly kind: "messages" }
  | { readonly kind: "fit-all" }

// How a step waits: on the agent (`nudge`: it rings the lead once after the tour's patience,
// and moves on after as long again), on the person's own doing (`patient`: as long as it
// takes), or on the person's Next (`next`), where it only shows something.
export type TourWait = "nudge" | "patient" | "next"

// What a run remembers across its signals: whether a teammate's question was seen waiting, so
// its going away is the person's answer.
export type TourMemory = { readonly asked: boolean }

// A step of the tour's story: what it moves as it begins, what it says while it waits, the
// signal that ends it, and how it waits (which may change once the run has seen something).
export type TourStep = {
  readonly id: string
  readonly enter: readonly TourMove[]
  readonly coach: Coach
  readonly done: (signals: TourSignals, memory: TourMemory) => boolean
  readonly wait: TourWait | ((memory: TourMemory) => TourWait)
}

export const waitOf = (step: TourStep, memory: TourMemory): TourWait =>
  typeof step.wait === "function" ? step.wait(memory) : step.wait

// Step 1 of the story: a terminal opens and the person's own agent starts there, with its
// brief, and describes itself as the tour's lead.
export const startStep: TourStep = {
  id: "start",
  enter: [{ kind: "view", view: "focus" }, { kind: "reveal" }],
  coach: {
    anchor: "terminal",
    title: "Your agent is starting",
    body: "This is your own agent, with your config and account, in a sandbox folder. It reads the tour's brief and gets to work.",
  },
  // It describes itself, as its brief asks; or, where a cheap model skips that, its first turn
  // ends.
  done: ({ lead }) => lead.kind === "agent" && (lead.named || lead.answered),
  wait: "nudge",
}

// Step 2: the lead opens two teammates, which show in the terminal list, linked to it, and
// name themselves.
export const teamStep: TourStep = {
  id: "team",
  enter: [{ kind: "reveal" }, { kind: "sidebar", panel: "terminals" }],
  coach: {
    anchor: "terminals",
    title: "Your agent opens a team",
    body: "It starts two teammates with Novadeck's tools. They show up here, linked to it, and name themselves.",
  },
  done: ({ team }) => team.count >= 2 && team.named >= 2,
  wait: "nudge",
}

// Step 3: the team talks, as the lead's Messages show.
export const talkStep: TourStep = {
  id: "talk",
  enter: [{ kind: "messages" }],
  coach: {
    anchor: "messages",
    title: "The team talks",
    body: "Agents message each other through Novadeck, across harnesses. Their messages show here, beside the lead.",
  },
  done: ({ talks }) => talks >= 2,
  wait: "nudge",
}

// Step 4: a teammate asks the person in the Inbox, and the team carries on with the answer.
// It waits on the agent until the question shows, then on the person, as long as they take.
export const askStep: TourStep = {
  id: "ask",
  enter: [{ kind: "inbox" }],
  coach: {
    anchor: "inbox-card",
    title: "A teammate asks you",
    body: "When an agent needs you, it asks in the Inbox. Pick a tagline: the team carries on with your answer.",
  },
  done: ({ asking, answered }, { asked }) => answered || (asked && !asking),
  wait: ({ asked }) => (asked ? "patient" : "nudge"),
}

// Step 5: the lead shows the result in the side pane beside its terminal.
export const showStep: TourStep = {
  id: "show",
  enter: [{ kind: "reveal" }],
  coach: {
    anchor: "side-pane",
    title: "Your agent shows you the result",
    body: "Agents show their work beside their terminal: here, the card your team made for you.",
  },
  done: ({ shown }) => shown,
  wait: "nudge",
}

// Step 6: zoom out, to every agent at once in Grid, then laid out freely in Canvas.
export const gridStep: TourStep = {
  id: "grid",
  enter: [{ kind: "view", view: "grid" }],
  coach: {
    anchor: "views",
    title: "All your agents at once",
    body: "Grid shows every terminal side by side. Switch views here any time.",
  },
  done: () => false,
  wait: "next",
}

export const canvasStep: TourStep = {
  id: "canvas",
  enter: [{ kind: "view", view: "canvas" }, { kind: "fit-all" }],
  coach: {
    anchor: "views",
    title: "Room to spread out",
    body: "Canvas lays your terminals out freely: pan, zoom, and arrange them as you work.",
  },
  done: () => false,
  wait: "next",
}

// The tour's steps, in order: the story the brief asks its agent to play.
export const tourSteps: readonly TourStep[] = [
  startStep,
  teamStep,
  talkStep,
  askStep,
  showStep,
  gridStep,
  canvasStep,
]

// What the tour says while the lead's agent holds at a screen of its own, whatever the step:
// the person answers it in the agent's terminal, and the tour waits as long as that takes.
export const screenCoach = (
  screen: Extract<LeadState, { kind: "screen" }>["screen"],
  agent: AgentName,
): Coach => ({
  anchor: "terminal",
  title: "Your agent is asking you something first",
  body:
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
  anchor: "terminal",
  terminalId,
  title: "Your agent is asking your permission",
  body: "It wants to do something in the tour's folder. Answer it here, in its terminal, and the tour goes on.",
})

// What the tour says once the lead's agent has stopped: its terminal is still there to read.
export const endedCoach: Coach = {
  anchor: "terminal",
  title: "Your agent stopped",
  body: "Its terminal shows why. Start it again there and the tour goes on, or end the tour.",
}
