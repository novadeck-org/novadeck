import type { ViewMode } from "@novadeck/core/types"

import type { LeadState, PaneTab, TourRole, TourSignals } from "./signals"

// What the tour marks on the page (`anchors.ts`): the window of a role, or its companion pane
// (its tabs: the page, the model, the changes, the image, Messages), the terminal the coach
// names, the teammates' windows, the approval dialog's button, the Inbox row waiting on the
// person, the answers of the request sheet open now, the Files panel, and the sidebar rail's
// buttons that open the Inbox and Files.
export type TourTarget =
  | TourRole
  | `${TourRole}-pane`
  | "terminal"
  | "team"
  | "approve"
  | "asking-row"
  | "answers"
  | "files"
  | "inbox-button"
  | "files-button"

// The tour's four acts, each opened by a wipe with its number and name. A step belongs to one.
export const tourActs = ["Your agent", "Your call", "The team", "The result"] as const
export type TourAct = 1 | 2 | 3 | 4

// What the tour says at a step: the line its caption box letters, beside what it marks, and for
// a moment the person has to act on, a note of what to do, under the box. It marks where to
// look (`look`) apart from what to press (`click`, the first of its targets drawn now). A step
// that waits on the person (`TourStep.person`) lists its subject first among them, then what
// opens it: only a touch on the subject counts.
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
  // Whether the press that opens its subject (the first of its `click` targets marked, while the
  // subject isn't there to mark) counts as the person's touch, as opening a sidebar panel does:
  // what they'd press in it next (a file) would take them away from the story.
  readonly opened?: true
  // Whether its box may lie over windows. A box keeps clear of every window where any free
  // space fits it; one whose step turns the person's eyes away from the windows (to the Inbox,
  // a question's sheet, the approval) goes beside what it marks instead, over them if need be.
  readonly overWindows?: boolean
}

// What the tour moves as a step begins, never again: the view, a role's terminal brought into
// view for a look and selected (`travel`: in Canvas the camera moves only where its window isn't
// on screen at a size to read, out to every window first and then in to it; the lead's where
// none is named), every window framed (Canvas). A move naming a role waits until that role is
// found. The tour opens no sidebar panel of its own: it marks the rail's button for the person.
export type TourMove =
  | { readonly kind: "view"; readonly view: ViewMode }
  | { readonly kind: "travel"; readonly role?: TourRole }
  | { readonly kind: "fit-all" }

// The tab a step opens in a role's companion pane: what an agent showed (a page, a model, its
// changes, an image) or its Messages. An item waits on a pane until its terminal is selected,
// so the step brings the terminal into view and opens the tab, the tab as soon as the item is
// there.
export type TourTab = {
  readonly role: TourRole
  readonly tab: PaneTab
}

// How a step waits: on the agent (`nudge`: it rings the agent once after the tour's patience,
// and moves on after as long again), or on the person's own doing (`patient`: as long as it
// takes).
export type TourWait = "nudge" | "patient"

// What a run remembers across its signals: whether the lead's sheet was seen waiting, so its
// going away is the person's answer.
export type TourMemory = { readonly asked: boolean }

// A step of the tour's story: its act, what it moves as it begins, what it says while it waits,
// the signal that ends it, and how it waits (which may change once the run has seen something).
export type TourStep = {
  readonly id: string
  readonly act: TourAct
  readonly enter: readonly TourMove[]
  // The pane tab it opens, once the item is there.
  readonly open?: TourTab
  // Every window is framed (Canvas) as the team grows while the step is on, only where a
  // teammate's window landed out of sight: the camera goes out, never across.
  readonly frameTeam?: boolean
  // Once done, the step waits for the person to touch its subject (the first of its coach's
  // `click` targets: a click or a focus in it, as spinning a model or clicking into a page),
  // however long they take, before the run moves on; its hold (`holdMs`), where it has one,
  // counts from that touch.
  readonly person?: true
  // How long the step's caption stays on screen once done, for the person to look at what it
  // shows, before the run moves on: counted from when the caption is shown.
  readonly holdMs?: number
  // How long the step waits at most, from when it began, before the run moves on all the same:
  // for a step that waits on agents at work, which no nudge counts.
  readonly capMs?: number
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

// How long a step that's done in moments keeps its caption box on screen, counted from when the
// box shows, so it is there long enough to read: for a step the agents end, which has nothing for
// the person to do.
const lineMs = 3_000

// Act 1: in Canvas, a terminal opens and the tour's opencode agent starts there, with its brief,
// and describes itself as the tour's lead.
export const startStep: TourStep = {
  id: "start",
  act: 1,
  enter: [{ kind: "view", view: "canvas" }, { kind: "travel" }],
  // A lead that names itself at once is done before its caption shows: it holds, so the first
  // beat is read.
  holdMs: lineMs,
  coach: { look: "lead", line: "That's your agent. It runs this job." },
  // It describes itself, as its brief asks; or, where a cheap model skips that, its first turn
  // ends.
  done: ({ lead }) => lead.kind === "agent" && (lead.named || lead.answered),
  wait: "nudge",
}

// Act 2: the lead asks the person, in the Inbox, what game to build: one sheet of two
// questions, the world and the kind. It waits on the agent until the sheet shows, then on the
// person, as long as they take: they open the Inbox (its button marked), its row, and answer.
export const askStep: TourStep = {
  id: "ask",
  act: 2,
  enter: [],
  coach: {
    click: ["answers", "asking-row", "inbox-button"],
    line: "Your call. What game?",
    note: "Open your Inbox: pick a world and a kind, or write your own.",
    overWindows: true,
  },
  done: ({ sheet }, { asked }) => sheet.answered || (asked && !sheet.asking),
  wait: ({ asked }) => (asked ? "patient" : "nudge"),
}

// Still act 2, the person's second call: with the answer, the lead asks to run the game's server
// in a new terminal, which Novadeck asks the person to allow, and opens nobody before they have
// answered: the approval has the screen to itself. It waits on the agent until the question
// shows, then on the person. Done once it was allowed (the lead opened a terminal) or the page is
// shown.
export const runStep: TourStep = {
  id: "run",
  act: 2,
  enter: [],
  coach: {
    click: ["approve"],
    line: "It wants to run the game. Fine. Say yes.",
    note: "An agent asks before its command runs in a new terminal.",
    overWindows: true,
  },
  done: ({ served }) => served,
  wait: (_, { approving }) => (approving ? "patient" : "nudge"),
}

// Act 3: allowed, the lead shows the game's page in its pane, a blank start the team fills in.
// It is on screen while the lead writes its teammates' tasks, and waits for the person to click
// into it.
export const pageStep: TourStep = {
  id: "page",
  act: 3,
  enter: [{ kind: "travel" }],
  open: { role: "lead", tab: "page" },
  person: true,
  coach: {
    click: ["lead-pane", "lead"],
    tab: "page",
    line: "The game. Live. Empty, for now.",
    note: "Click into it.",
  },
  done: ({ shown }) => shown.page !== null,
  wait: "nudge",
}

// Still act 3: the lead opens its two teammates, which come up on the canvas, wired to it, and
// name themselves; the camera pulls back only where one lands out of sight. Once both are there,
// it waits for the person to click one.
export const teamStep: TourStep = {
  id: "team",
  act: 3,
  enter: [],
  frameTeam: true,
  person: true,
  coach: { click: ["team"], line: "Look. It hired its own help.", note: "Click one." },
  done: ({ team }) => team.count >= 2 && team.named >= 2,
  wait: "nudge",
}

// Still act 3: the modeller's first model, in 3D in its pane, for the person to spin.
export const shapeStep: TourStep = {
  id: "shape",
  act: 3,
  enter: [{ kind: "travel", role: "modeller" }],
  open: { role: "modeller", tab: "model" },
  person: true,
  coach: {
    click: ["modeller-pane", "modeller"],
    tab: "model",
    line: "A model. From scratch. Go on, spin it.",
    note: "Drag it.",
  },
  done: ({ shown }) => shown.model !== null,
  wait: "nudge",
  nudges: "modeller",
}

// Still act 3: the agents write in their own worktrees, and the Files panel shows each blink:
// the person opens it (its rail button marked), which is all the step asks. Done once the models and the
// game have each been changed.
export const filesStep: TourStep = {
  id: "files",
  act: 3,
  enter: [],
  person: true,
  coach: {
    click: ["files", "files-button"],
    opened: true,
    line: "Every blink? An agent. Writing.",
    note: "Open Files on the left.",
  },
  done: ({ changed }) => changed.models && changed.game,
  wait: "nudge",
  // The modeller is the one writing, until the models are changed; then the builder is.
  nudges: ({ changed }) => (changed.models ? "builder" : "modeller"),
}

// Still act 3: the builder's pane, with the diff it shows of the game it wrote.
export const diffStep: TourStep = {
  id: "diff",
  act: 3,
  enter: [{ kind: "travel", role: "builder" }],
  open: { role: "builder", tab: "changes" },
  person: true,
  coach: {
    click: ["builder-pane", "builder"],
    tab: "changes",
    line: "What it wrote. Line by line.",
    note: "Click a file to see its lines.",
  },
  done: ({ shown }) => shown.changes !== null,
  wait: "nudge",
  nudges: "builder",
}

// Still act 3: the team finishes what it started, its answers to the person's questions taken
// in; the story ends only then, so the project keeps the whole game. Done once every teammate
// has reported to the lead and none is at work or waits on the person, and held a moment, as a
// teammate may take up a new turn right after. A run that never settles ends all the same.
export const finishStep: TourStep = {
  id: "finish",
  act: 3,
  enter: [],
  holdMs: lineMs,
  capMs: 5 * 60_000,
  coach: { look: "team", line: "They're finishing it." },
  done: ({ team, askingRow, permission }) =>
    team.count > 0 &&
    team.reported >= team.count &&
    !team.working &&
    askingRow === null &&
    permission === null,
  // No nudge while a teammate is at work: the lead is rung only once all are quiet.
  wait: (_, { team }) => (team.working ? "patient" : "nudge"),
}

// Act 4: the result's wipe, then the game in the lead's pane, for the person to play: a while
// after they first click into it, the story ends and the closing card comes.
export const playStep: TourStep = {
  id: "play",
  act: 4,
  enter: [{ kind: "travel" }],
  open: { role: "lead", tab: "page" },
  person: true,
  holdMs: 20_000,
  coach: {
    click: ["lead-pane", "lead"],
    tab: "page",
    line: "Three agents. Your game. Go play.",
    note: "It's live in the pane: click it.",
  },
  // Never while a teammate's question waits: the closing card waits for the person's answer.
  done: ({ askingRow }) => askingRow === null,
  wait: "patient",
}

// The same, where there is no page to play (this computer has neither Node nor Python 3): the
// modeller's model is what is left to look at.
const modelPlayStep: TourStep = {
  ...playStep,
  enter: [{ kind: "travel", role: "modeller" }],
  open: { role: "modeller", tab: "model" },
  holdMs: 8_000,
  coach: {
    click: ["modeller-pane", "modeller"],
    tab: "model",
    line: "Three agents. Your game. Yours.",
    note: "Give it one more spin.",
  },
}

const played = {
  page: [
    startStep,
    askStep,
    runStep,
    pageStep,
    teamStep,
    shapeStep,
    filesStep,
    diffStep,
    finishStep,
    playStep,
  ],
  noPage: [startStep, askStep, teamStep, shapeStep, filesStep, diffStep, finishStep, modelPlayStep],
} as const

// The tour's steps, in order: the story the briefs ask the agents to play.
export const tourSteps: readonly TourStep[] = played.page

// The steps a run plays: without a page (no Node or Python 3 here, or the person declined the
// run) the run and page steps are left out and the story ends on the model.
export const stepsOf = (page: boolean): readonly TourStep[] => played[page ? "page" : "noPage"]

// What the tour moves as its story ends: every window framed, for the closing card.
export const closingMoves: readonly Extract<TourMove, { kind: "fit-all" }>[] = [{ kind: "fit-all" }]

// What the tour says while the lead's agent holds at a screen of its own, whatever the step:
// the person answers it in the agent's terminal, and the tour waits as long as that takes.
// opencode holds at none in practice (it has no trust, sign-in or hooks-review screen); the words
// for each are for the one way it can't be followed: Novadeck's plugin kept out by the person's
// own environment.
export const screenCoach = (screen: Extract<LeadState, { kind: "screen" }>["screen"]): Coach => ({
  click: ["terminal"],
  line: "It wants an answer first.",
  note:
    screen === "hooks"
      ? "Novadeck can't load its plugin into opencode here, so it can't follow it: your environment sets both OPENCODE_CONFIG_CONTENT and OPENCODE_CONFIG, or OPENCODE_PURE. Unset one, then start it again here."
      : "Answer it here, in its terminal: it's its own question. The tour goes on once you have.",
})

// What the tour says while a teammate's own question to the person waits in the Inbox: it isn't
// part of the story, and the tour points at it until they answer or dismiss it.
export const questionCoach: Coach = {
  click: ["answers", "asking-row", "inbox-button"],
  line: "A teammate has a question for you.",
  note: "Answer it in the Inbox, or dismiss it and it decides itself.",
  overWindows: true,
}

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
