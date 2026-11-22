import type { AgentName } from "@novadeck/core/harnesses"
import type { SidebarPanel, ViewMode } from "@novadeck/core/types"

import type { LeadState, PaneTab, TourRole, TourSignals } from "./signals"

// What the tour marks on the page (`anchors.ts`): the window of a role, or its companion pane
// (its tabs: the page, the model, the changes, the image, Messages), the terminal the coach
// names, the teammates' windows, the approval dialog's button, the Inbox row waiting on the
// person, the answers of the request sheet open now, and the Files panel.
export type TourTarget =
  | TourRole
  | `${TourRole}-pane`
  | "terminal"
  | "team"
  | "approve"
  | "asking-row"
  | "answers"
  | "files"

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
  // The pane tab a `<role>-pane` look is about: it marks only while that tab is the open, top
  // one of the role's pane, so nothing is marked (and no caption shows) before its subject is.
  readonly tab?: PaneTab
  readonly line: string
  readonly note?: string
  // Whether its box may lie over windows. A box keeps clear of every window where any free
  // space fits it; one whose step turns the person's eyes away from the windows (to the Inbox,
  // a question's sheet, the approval) goes beside what it marks instead, over them if need be.
  readonly overWindows?: boolean
}

// What the tour moves as a step begins, never again: the view, a role's terminal brought into
// view and selected (in Canvas the camera flies to it; the lead's where none is named) with a
// sidebar panel opened where one is named, the Inbox, every window framed (Canvas). A move
// naming a role waits until that role is found.
export type TourMove =
  | { readonly kind: "view"; readonly view: ViewMode }
  | { readonly kind: "reveal"; readonly role?: TourRole; readonly panel?: SidebarPanel }
  | { readonly kind: "inbox" }
  | { readonly kind: "fit-all" }

// The tab a step opens in a role's companion pane: what an agent showed (a page, a model, its
// changes, an image) or its Messages. An item waits on a pane until its terminal is selected,
// so the step reveals the terminal and opens the tab, the tab as soon as the item is there.
export type TourTab = {
  readonly role: TourRole
  readonly tab: PaneTab
}

// How a step waits: on the agent (`nudge`: it rings the agent once after the tour's patience,
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
  // The pane tab it opens, once the item is there.
  readonly open?: TourTab
  // Every window is framed again as the team grows while the step is on, so the camera keeps
  // the new windows in view (Canvas).
  readonly frameTeam?: boolean
  // Whether the step begins the artist: its terminal is opened, once per run, in the tour's
  // project.
  readonly opensArtist?: boolean
  // How long the step stays once done, for the person to look at what it shows, before the
  // run moves on.
  readonly holdMs?: number
  readonly coach: Coach
  readonly done: (signals: TourSignals, memory: TourMemory) => boolean
  readonly wait: TourWait | ((memory: TourMemory, signals: TourSignals) => TourWait)
  // Whom the step waits on, and so whom its nudge rings: the lead where none is named.
  readonly nudges?: TourRole | ((signals: TourSignals) => TourRole)
}

export const waitOf = (step: TourStep, memory: TourMemory, signals: TourSignals): TourWait =>
  typeof step.wait === "function" ? step.wait(memory, signals) : step.wait

export const nudgeOf = (step: TourStep, signals: TourSignals): TourRole =>
  typeof step.nudges === "function" ? step.nudges(signals) : (step.nudges ?? "lead")

// How long a step that's done in moments stays, so its caption box, which shows a second after
// what the step marks, is on screen long enough to read.
const lineMs = 3_000

// Act 1: in Canvas, a terminal opens and the person's own agent starts there, with its brief,
// and describes itself as the tour's lead.
export const startStep: TourStep = {
  id: "start",
  act: 1,
  enter: [{ kind: "view", view: "canvas" }, { kind: "reveal" }],
  coach: { look: "lead", line: "Your own agent. It leads the build." },
  // It describes itself, as its brief asks; or, where a cheap model skips that, its first turn
  // ends.
  done: ({ lead }) => lead.kind === "agent" && (lead.named || lead.answered),
  wait: "nudge",
}

// Act 2: the lead opens its two teammates, which come up on the canvas, wired to it, and name
// themselves; the camera pulls back to frame them as they come. Done, it stays a moment
// (`lineMs`), as they name themselves in seconds, for its line to be read.
export const teamStep: TourStep = {
  id: "team",
  act: 2,
  enter: [{ kind: "fit-all" }],
  frameTeam: true,
  holdMs: lineMs,
  coach: { look: "team", line: "It hired a team." },
  done: ({ team }) => team.count >= 2 && team.named >= 2,
  wait: "nudge",
}

// Still act 2: the lead asks to run the game's server in a new terminal, which Novadeck asks the
// person to allow. It waits on the agent until the question shows, then on the person. Done once
// it was allowed (the lead opened a terminal) or the page is shown.
export const runStep: TourStep = {
  id: "run",
  act: 2,
  enter: [],
  coach: {
    click: ["approve"],
    line: "They want to run the game. Say yes.",
    note: "An agent asks before its command runs in a new terminal.",
    overWindows: true,
  },
  done: ({ served }) => served,
  wait: (_, { approving }) => (approving ? "patient" : "nudge"),
}

// Still act 2: the lead shows the game's page, plain, in its pane.
export const pageStep: TourStep = {
  id: "page",
  act: 2,
  enter: [{ kind: "reveal" }],
  open: { role: "lead", tab: "page" },
  holdMs: 6_000,
  coach: { look: "lead-pane", tab: "page", line: "The game, live. Still plain." },
  done: ({ shown }) => shown.page !== null,
  wait: "nudge",
}

// Still act 2: the hero as it is, a ball and a box, in the sculptor's pane, before the person is
// asked what it should be, so the change that follows lands.
export const shapeStep: TourStep = {
  id: "shape",
  act: 2,
  enter: [{ kind: "reveal", role: "sculptor" }],
  open: { role: "sculptor", tab: "model" },
  holdMs: 4_000,
  coach: { look: "sculptor-pane", tab: "model", line: "The hero so far. A ball and a box." },
  done: ({ shown }) => shown.model !== null,
  wait: "nudge",
  nudges: "sculptor",
}

// Act 3: the sculptor asks the person in the Inbox, and the team carries on with the answer.
// It waits on the agent until the question shows, then on the person, as long as they take.
export const askStep: TourStep = {
  id: "ask",
  act: 3,
  enter: [{ kind: "inbox" }],
  coach: {
    click: ["answers", "asking-row"],
    line: "Your call. Who's the hero?",
    overWindows: true,
  },
  done: ({ asking, answered }, { asked }) => answered || (asked && !asking),
  wait: ({ asked }) => (asked ? "patient" : "nudge"),
}

// Still act 3: the agents write in their own worktrees, and the Files panel shows each blink,
// with the sculptor's model beside it: its pane re-reads the file as it is saved, so the hero
// changes in front of the person. Done once the hero's model and the score have each been changed.
export const filesStep: TourStep = {
  id: "files",
  act: 3,
  enter: [{ kind: "reveal", role: "sculptor", panel: "files" }],
  open: { role: "sculptor", tab: "model" },
  holdMs: 5_000,
  coach: { look: "files", line: "Every blink is an agent writing." },
  done: ({ changed }) => changed.hero && changed.score,
  wait: "nudge",
  // The sculptor is the one writing, until the hero is changed; then the fixer is.
  nudges: ({ changed }) => (changed.hero ? "fixer" : "sculptor"),
}

// Still act 3: the sculptor's pane, its model open in 3D.
export const modelStep: TourStep = {
  id: "model",
  act: 3,
  enter: [{ kind: "reveal", role: "sculptor" }],
  open: { role: "sculptor", tab: "model" },
  holdMs: 5_000,
  coach: { look: "sculptor-pane", tab: "model", line: "Your hero, in 3D. Spin it." },
  done: ({ changed, shown }) => changed.hero && changed.score && shown.model !== null,
  wait: "nudge",
  nudges: "sculptor",
}

// Still act 3: the fixer's pane, with the diff it shows of what it changed.
export const diffStep: TourStep = {
  id: "diff",
  act: 3,
  enter: [{ kind: "reveal", role: "fixer" }],
  open: { role: "fixer", tab: "changes" },
  holdMs: 4_000,
  coach: {
    look: "fixer-pane",
    tab: "changes",
    line: "It shows what it changed.",
    note: "Click a file to see its lines.",
  },
  done: ({ shown }) => shown.changes !== null,
  wait: "nudge",
  nudges: "fixer",
}

// Still act 3: an agent on no team, which the tour itself starts in a terminal of the project
// and rings its brief. It describes itself, and the person sees it isn't one of the lead's.
export const outsiderStep: TourStep = {
  id: "outsider",
  act: 3,
  enter: [{ kind: "fit-all" }],
  frameTeam: true,
  opensArtist: true,
  holdMs: lineMs,
  coach: { look: "artist", line: "Another agent. Not on the team." },
  done: ({ artist }) => artist?.kind === "agent" && artist.named,
  wait: "nudge",
  nudges: "artist",
}

// Still act 3: the artist finds the lead by itself with `agents` and asks it what the game is,
// and the lead answers: its Messages tab shows both.
export const talkStep: TourStep = {
  id: "talk",
  act: 3,
  enter: [{ kind: "reveal", role: "artist" }],
  open: { role: "artist", tab: "messages" },
  holdMs: 4_000,
  coach: {
    look: "artist-pane",
    tab: "messages",
    line: "It found the lead by itself. And asked.",
  },
  done: ({ talk }) => talk.toLead && talk.fromLead,
  wait: "nudge",
  // The artist has to ask first; once it has, the lead's answer is what is owed.
  nudges: ({ talk }) => (talk.toLead ? "lead" : "artist"),
}

// Still act 3: the artist's cover, its image open in its pane.
export const coverStep: TourStep = {
  id: "cover",
  act: 3,
  enter: [{ kind: "reveal", role: "artist" }],
  open: { role: "artist", tab: "cover" },
  holdMs: 4_000,
  coach: { look: "artist-pane", tab: "cover", line: "Its cover. For your game." },
  done: ({ shown }) => shown.cover !== null,
  wait: "nudge",
  nudges: "artist",
}

// Act 4: the result's wipe, then the finished game in the lead's pane, for the person to play,
// a while; then the story ends and the closing card comes.
export const playStep: TourStep = {
  id: "play",
  act: 4,
  enter: [{ kind: "reveal" }],
  open: { role: "lead", tab: "page" },
  // A round of the game lasts 20 s.
  holdMs: 25_000,
  coach: {
    look: "lead-pane",
    tab: "page",
    line: "Four agents. One game. Play it.",
    note: "It's live in the pane: click it.",
  },
  done: () => true,
  wait: "patient",
}

// The same, where there is no page to play (this computer has neither Node nor Python 3): the
// sculptor's model is what is left to look at.
const modelPlayStep: TourStep = {
  ...playStep,
  enter: [{ kind: "reveal", role: "sculptor" }],
  open: { role: "sculptor", tab: "model" },
  holdMs: 8_000,
  coach: { look: "sculptor-pane", tab: "model", line: "Four agents. One game. Yours." },
}

const artistSteps: readonly TourStep[] = [outsiderStep, talkStep, coverStep]

const stories = {
  page: [
    startStep,
    teamStep,
    runStep,
    pageStep,
    shapeStep,
    askStep,
    filesStep,
    modelStep,
    diffStep,
  ],
  noPage: [startStep, teamStep, shapeStep, askStep, filesStep, modelStep, diffStep],
} as const

// The last step, with the agents the story had: three where there was no artist.
const playFor = (page: boolean, artist: boolean): TourStep => {
  const base = page ? playStep : modelPlayStep
  const line = `${artist ? "Four" : "Three"} agents. One game. ${page ? "Play it." : "Yours."}`
  return { ...base, coach: { ...base.coach, line } }
}

const build = (page: boolean, artist: boolean): readonly TourStep[] => [
  ...stories[page ? "page" : "noPage"],
  ...(artist ? artistSteps : []),
  playFor(page, artist),
]

const played = {
  "page+artist": build(true, true),
  page: build(true, false),
  artist: build(false, true),
  none: build(false, false),
} as const

// The tour's steps, in order: the story the briefs ask the agents to play.
export const tourSteps: readonly TourStep[] = played["page+artist"]

// The steps a run plays: without a page (no Node or Python 3 here, or the person declined the
// run) the run and page steps are left out and the story ends on the model; without an artist (the
// backend has none, or it was dropped) its three steps are left out too.
export const stepsOf = (page: boolean, hasArtist: boolean): readonly TourStep[] =>
  played[page ? (hasArtist ? "page+artist" : "page") : hasArtist ? "artist" : "none"]

// What the tour moves as its story ends: every window framed, for the closing card.
export const closingMoves: readonly Extract<TourMove, { kind: "fit-all" }>[] = [{ kind: "fit-all" }]

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
        : agent === "claude"
          ? 'Claude Code asks whether to trust the tour\'s folder, which Novadeck just made: pick "Yes, I trust this folder" here (it starts on "No"), and the tour goes on.'
          : agent === "codex"
            ? 'Codex asks whether to trust the tour\'s folder, which Novadeck just made: pick "Trust and continue" here, and the tour goes on.'
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

// What the tour says while an agent's program has ended and its shell is back, as Claude Code
// leaves where the person doesn't trust the tour's folder: the tour starts over. The lead's
// terminal where none is named.
export const leftCoach = (terminalId?: string): Coach => ({
  click: terminalId === undefined ? ["lead"] : ["terminal"],
  ...(terminalId !== undefined && { terminalId }),
  line: "It didn't start.",
  // The same for any of them: the shell's history doesn't hold the command the tour started it
  // with, so there is nothing the person could run again by a key.
  note: "Its terminal says why. End the tour and take it again.",
})
