import type { ViewMode } from "@novadeck/core/types"

import type { LeadState, PaneTab, TourRole, TourSignals } from "./signals"

// What the tour marks on the page (`anchors.ts`): the window of a role, or its companion pane
// (its tabs: the page, the model, Messages), the terminal the coach
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
  // Whether its subject being on screen counts as the person's touch, however it came (they
  // opened a sidebar panel by its rail button, a key, or had it open already): what they'd press
  // in it next (a file) would take them away from the story.
  readonly opened?: true
  // What the box says instead of `line` while the step's subject (the first of its `click`
  // targets) isn't on screen yet and the person can bring it there: by what opens it, marked, or
  // the box's own button. The line is the beat, said only once its subject is in front of them;
  // without a cue, the line is said wherever any of its targets is marked.
  readonly cue?: { readonly line: string; readonly note?: string }
  // Whether its box may lie over windows. A box keeps clear of every window where any free
  // space fits it; one whose step turns the person's eyes away from the windows (to the Inbox,
  // a question's sheet, the approval) goes beside what it marks instead, over them if need be.
  readonly overWindows?: boolean
}

// What the caption box's button moves, as the person presses it: never the tour on its own, which
// opens, pans and zooms nothing. The view, a role's terminal brought into view for a look and
// selected (`travel`: in Canvas the camera moves only where its window isn't on screen at a size
// to read, out to every window first and then in to it; the lead's where none is named), every
// window framed (Canvas). A move naming a role is made only once that role is found. No sidebar
// panel either: the tour marks the rail's button for the person.
export type TourMove =
  | { readonly kind: "view"; readonly view: ViewMode }
  | { readonly kind: "travel"; readonly role?: TourRole }
  | { readonly kind: "fit-all" }

// The tab of a role's companion pane the caption box's button opens, beside its moves: what an
// agent showed (a page, a model, its changes, an image) or its Messages, once the item is there.
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

// A step of the tour's story: its act, what its caption box's button brings into view, what it
// says while it waits, the signal that ends it, and how it waits (which may change once the run
// has seen something).
export type TourStep = {
  readonly id: string
  readonly act: TourAct
  // What the box's button moves, as the person presses it; none, no button (but where what the
  // step marks is out of sight: "Show me" then brings it back).
  readonly show: readonly TourMove[]
  // The pane tab the button opens too, once the item is there.
  readonly open?: TourTab
  // Whether what the step is about is there to see yet: until it is (the agent hasn't shown it,
  // or hired anyone), the step says nothing, so no beat comes before its subject. Always, where
  // none is given.
  readonly ready?: (signals: TourSignals) => boolean
  // Once done, the step waits for the person to touch its subject (the first of its coach's
  // `click` targets: a click or a focus in it, as spinning a model or clicking into a page),
  // however long they take, before the run moves on; its hold (`holdMs`), where it has one,
  // counts from that touch, or from its line's caption showing where that comes later (a cue
  // said until then).
  readonly person?: true
  // How long the step's caption stays on screen once done, for the person to look at what it
  // shows, before the run moves on: counted from when the caption is shown.
  readonly holdMs?: number
  // How long the step waits at most, from when it began, before the run moves on all the same:
  // for a step that waits on agents at work, which no nudge counts.
  readonly capMs?: number
  // Whether the step's subject will never come, so the run moves on at once, as at its cap: for a
  // beat the agents may leave out.
  readonly skip?: (signals: TourSignals) => boolean
  readonly coach: Coach
  readonly done: (signals: TourSignals, memory: TourMemory) => boolean
  readonly wait: TourWait | ((memory: TourMemory, signals: TourSignals) => TourWait)
  // Whom the step waits on, and so whom its nudge rings: the lead where none is named.
  readonly nudges?: TourRole | ((signals: TourSignals) => TourRole)
  // Whether the step is about a teammate's question in the Inbox: its own coach then speaks while
  // one waits, in place of the general one (`questionCoach`).
  readonly asks?: true
}

export const waitOf = (step: TourStep, memory: TourMemory, signals: TourSignals): TourWait =>
  typeof step.wait === "function" ? step.wait(memory, signals) : step.wait

export const nudgeOf = (step: TourStep, signals: TourSignals): TourRole =>
  typeof step.nudges === "function" ? step.nudges(signals) : (step.nudges ?? "lead")

// How long a step that's done in moments keeps its caption box on screen, counted from when the
// box shows, so it is there long enough to read and for Nyx to say it (her `start` take runs about
// 3.5 s): for a step the agents end, which has nothing for the person to do.
const lineMs = 4_000

// Act 1: in Canvas, a terminal opens and the tour's Pi agent starts there, with its brief,
// and describes itself as the tour's lead.
export const startStep: TourStep = {
  id: "start",
  act: 1,
  // No button: the run began on its window, in Canvas, as the person started it, the one window
  // there ("Show me", once it's out of sight, travels back to it all the same).
  show: [],
  // A lead that names itself at once is done before its caption shows: it holds, so the first
  // beat is read.
  holdMs: lineMs,
  coach: { look: "lead", line: "That's your agent. It does the work. I talk." },
  // It describes itself, as its brief asks; or, where a cheap model skips that, its first turn
  // ends.
  done: ({ lead }) => lead.kind === "agent" && (lead.named || lead.answered),
  wait: "nudge",
}

// Act 2: the lead asks the person, in the Inbox, what game to build: three pitches to pick from,
// or their own words. It waits on the agent until the question shows, then on the person, as long
// as they take: they open the Inbox (its button marked), its row, and answer.
export const askStep: TourStep = {
  id: "ask",
  act: 2,
  show: [],
  coach: {
    click: ["answers", "asking-row", "inbox-button"],
    line: "Your call. What game? Make it a good one.",
    note: "Open your Inbox: pick a game, or write your own.",
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
  show: [],
  coach: {
    click: ["approve"],
    line: "It wants to run the game. Fine. Say yes.",
    note: "An agent asks before its command runs in a new terminal.",
    overWindows: true,
  },
  done: ({ served }) => served,
  wait: (_, { approving }) => (approving ? "patient" : "nudge"),
}

// Act 3: the lead opens its teammates, which come up on the canvas, wired to it, and name
// themselves. Silent until the first is there; where they landed out of sight, the box's button
// frames every window. Done once every one that came up has named itself, as the lead opens them
// one after another, and then it waits for the person to click one.
export const teamStep: TourStep = {
  id: "team",
  act: 3,
  show: [{ kind: "fit-all" }],
  ready: ({ team }) => team.count > 0,
  person: true,
  coach: {
    click: ["team"],
    cue: {
      line: "New agents? Go find them.",
      note: "They're off screen: the eye shows them.",
    },
    line: "Look. It hired its own help. Without asking me?",
    note: "Click one.",
  },
  done: ({ team, lead }) =>
    team.count > 0 &&
    team.named >= team.count &&
    (team.count >= 3 || (lead.kind === "agent" && !lead.working)),
  wait: "nudge",
}

// Still act 3: allowed, the lead shows the game's page in its pane, which opens on the kit's
// showcase, a start the team changes. Silent until the page is there; then, until the person has
// it on screen, it says so; it waits for them to click into it.
export const pageStep: TourStep = {
  id: "page",
  act: 3,
  show: [{ kind: "travel" }],
  open: { role: "lead", tab: "page" },
  ready: ({ shown }) => shown.page !== null,
  person: true,
  coach: {
    click: ["lead-pane", "lead"],
    tab: "page",
    cue: { line: "Your game's running. Go look.", note: "Open it: the eye, or its window." },
    line: "There. Just a showcase. Wait for yours.",
    note: "Click into it.",
  },
  done: ({ shown }) => shown.page !== null,
  wait: "nudge",
}

// Still act 3: a teammate wrote to another teammate, not to the lead, about what it exports or
// needs. Silent until one has; the box's button opens the sender's Messages, where the lines are.
export const talkStep: TourStep = {
  id: "talk",
  act: 3,
  show: [{ kind: "travel", role: "talker" }],
  open: { role: "talker", tab: "messages" },
  ready: ({ roles }) => roles.talker !== undefined,
  person: true,
  coach: {
    click: ["talker-pane", "talker"],
    tab: "messages",
    cue: {
      line: "They're talking. Go listen.",
      note: "Open its Messages: the eye, or its window.",
    },
    line: "Agent to agent. Not through me.",
    note: "Click a thread to read it.",
  },
  done: ({ roles }) => roles.talker !== undefined,
  wait: "nudge",
  nudges: "mate",
}

// Still act 3: a teammate's question to the person arrives in the Inbox while the others carry on:
// the windows show who is at work and who waits on you. Silent until it does; done once none
// waits, or where every teammate has finished without asking.
export const mateAskStep: TourStep = {
  id: "mate-ask",
  act: 3,
  show: [{ kind: "fit-all" }],
  ready: ({ askingRow }) => askingRow !== null,
  asks: true,
  coach: {
    look: "team",
    click: ["answers", "asking-row", "inbox-button"],
    line: "One of them waits on you. The rest keep working.",
    note: "Answer it in the Inbox, or dismiss it and it decides itself.",
    overWindows: true,
  },
  done: ({ team, askingRow }) =>
    askingRow === null && (team.asked || (team.count > 0 && team.polished >= team.count)),
  wait: "nudge",
  nudges: "mate",
}

// Still act 3: the maker's first model, in 3D in its pane, for the person to spin: silent until
// it's there.
export const shapeStep: TourStep = {
  id: "shape",
  act: 3,
  show: [{ kind: "travel", role: "maker" }],
  open: { role: "maker", tab: "model" },
  ready: ({ shown }) => shown.model !== null,
  person: true,
  coach: {
    click: ["maker-pane", "maker"],
    tab: "model",
    cue: { line: "Its first model's done. Have a look.", note: "Open it: the eye, or its window." },
    line: "A model, made from nothing. Go on. Spin it.",
    note: "Drag it.",
  },
  done: ({ shown }) => shown.model !== null,
  // A team that builds its characters in code shows no model: once every teammate's first
  // version is in with none shown, none is coming, and the story goes on without the beat.
  skip: ({ shown, team }) => shown.model === null && team.count > 0 && team.firstIn >= team.count,
  wait: "nudge",
  nudges: "mate",
}

// Still act 3: the first versions land, and the lead's page changes under the person's eyes.
// Silent until a teammate has told the lead its first version is in; the page is the subject, its
// pane or the lead's window marked where it isn't on top.
export const firstStep: TourStep = {
  id: "first",
  act: 3,
  show: [{ kind: "travel" }],
  open: { role: "lead", tab: "page" },
  ready: ({ team }) => team.firstIn > 0,
  holdMs: 5_000,
  coach: {
    click: ["lead-pane", "lead"],
    tab: "page",
    line: "First versions are in. Watch your page change.",
  },
  done: ({ team }) => team.firstIn > 0,
  wait: "nudge",
  nudges: "mate",
}

// Still act 3: the polishing round, as the first teammate says its part is polished: the page
// changes again.
export const polishStep: TourStep = {
  id: "polish",
  act: 3,
  show: [{ kind: "travel" }],
  open: { role: "lead", tab: "page" },
  ready: ({ team }) => team.polished > 0,
  holdMs: 5_000,
  coach: {
    click: ["lead-pane", "lead"],
    tab: "page",
    line: "Polishing now. See it change again.",
  },
  done: ({ team }) => team.polished > 0,
  wait: "nudge",
  nudges: "mate",
}

// Still act 3: the team finishes what it started, its answers to the person's questions taken
// in; the story ends only then, so the project keeps the whole game. Done once every teammate
// has told the lead its part is polished and none is at work or waits on the person, and held a
// moment, as a teammate may take up a new turn right after. A run that never settles ends all
// the same: the game is meant to be playable about seven minutes in.
export const finishStep: TourStep = {
  id: "finish",
  act: 3,
  show: [{ kind: "fit-all" }],
  holdMs: lineMs,
  capMs: 8 * 60_000,
  coach: { look: "team", line: "They're finishing it. Relax." },
  done: ({ team, askingRow, permission }) =>
    team.count > 0 &&
    team.polished >= team.count &&
    !team.working &&
    askingRow === null &&
    permission === null,
  // No nudge while a teammate is at work: the lead is rung only once all are quiet.
  wait: (_, { team }) => (team.working ? "patient" : "nudge"),
  nudges: "mate",
}

// Act 4: the result's wipe, then the game in the lead's pane, for the person to play: a while
// after they first click into it, the story ends and the closing card comes.
export const playStep: TourStep = {
  id: "play",
  act: 4,
  show: [{ kind: "travel" }],
  open: { role: "lead", tab: "page" },
  ready: ({ shown }) => shown.page !== null,
  person: true,
  holdMs: 20_000,
  coach: {
    click: ["lead-pane", "lead"],
    tab: "page",
    cue: { line: "Your game's done. Go open it.", note: "Open it: the eye, or its window." },
    line: "Three agents, one game. Go play.",
    note: "It's live in the pane: click it.",
  },
  // Never while a teammate's question waits: the closing card waits for the person's answer.
  done: ({ askingRow }) => askingRow === null,
  wait: "patient",
}

// The same, where there is no page to play (this computer has neither Node nor Python 3): the
// maker's model is what is left to look at.
const modelPlayStep: TourStep = {
  ...playStep,
  show: [{ kind: "travel", role: "maker" }],
  open: { role: "maker", tab: "model" },
  ready: ({ shown }) => shown.model !== null,
  // A team that built its characters in code has no model to end on: the story ends without it.
  skip: ({ shown }) => shown.model === null,
  holdMs: 8_000,
  coach: {
    click: ["maker-pane", "maker"],
    tab: "model",
    cue: {
      line: "Your model's done. Go open it.",
      note: "Open its model: the eye, or its window.",
    },
    line: "Three agents, one model. Yours.",
    note: "Give it one more spin.",
  },
}

const played = {
  page: [
    startStep,
    askStep,
    runStep,
    teamStep,
    pageStep,
    talkStep,
    mateAskStep,
    shapeStep,
    firstStep,
    polishStep,
    finishStep,
    playStep,
  ],
  noPage: [
    startStep,
    askStep,
    teamStep,
    talkStep,
    mateAskStep,
    shapeStep,
    finishStep,
    modelPlayStep,
  ],
} as const

// The tour's steps, in order: the story the briefs ask the agents to play.
export const tourSteps: readonly TourStep[] = played.page

// The steps a run plays: without a page (no Node or Python 3 here, or the person declined the
// run) the run, page and page-change steps are left out and the story ends on the model.
export const stepsOf = (page: boolean): readonly TourStep[] => played[page ? "page" : "noPage"]

// The closing card's line, the last thing the tour says.
export const closingLine = "It's yours now. Don't break it."

// What the tour says while the lead's agent holds at a screen of its own, whatever the step:
// the person answers it in the agent's terminal, and the tour waits as long as that takes.
// Pi holds at none in practice (Nova has no trust, sign-in or hooks-review screen);
// the words are for a screen it might show all the same.
export const screenCoach = (screen: Extract<LeadState, { kind: "screen" }>["screen"]): Coach => ({
  click: ["terminal"],
  line: "It wants an answer first. From you.",
  note:
    screen === "hooks"
      ? "Novadeck can't follow it until that's answered. Answer it in its terminal, then the tour goes on."
      : "Answer it here, in its terminal: it's its own question. The tour goes on once you have.",
})

// What the tour says over `screenCoach`'s words while a teammate, not the lead, holds at a screen
// of its own.
export const teamScreenLine = "A teammate wants an answer first. From you."

// What the tour says while a teammate's own question to the person waits in the Inbox: it isn't
// part of the story, and the tour points at it until they answer or dismiss it.
export const questionCoach: Coach = {
  click: ["answers", "asking-row", "inbox-button"],
  line: "A teammate has a question. Huh? For you, not me.",
  note: "Answer it in the Inbox, or dismiss it and it decides itself.",
  overWindows: true,
}

// What the tour says while an agent of the team asks the person's permission: it isn't part of
// the story, and the tour waits until they answer.
export const permissionCoach = (terminalId: string): Coach => ({
  click: ["terminal"],
  terminalId,
  line: "It's asking your permission. Read it first.",
  note: "It wants to do something in the tour's folder. Answer it here, in its terminal, and the tour goes on.",
})

// What the tour says once the lead's agent has stopped: its terminal is still there to read.
export const endedCoach: Coach = {
  click: ["lead"],
  line: "Your agent stopped. Ugh. Rude.",
  note: "Its terminal shows why. Start it again there and the tour goes on, or end the tour.",
}

// What the tour says while an agent's program has ended and its shell is back, as Claude Code
// leaves where the person doesn't trust the tour's folder: the tour starts over. The lead's
// terminal where none is named.
export const leftCoach = (terminalId?: string): Coach => ({
  click: terminalId === undefined ? ["lead"] : ["terminal"],
  ...(terminalId !== undefined && { terminalId }),
  // The lead's never got going; a teammate's may have worked a while first.
  line: terminalId === undefined ? "What? It didn't even start." : "A teammate quit.",
  // The same for any of them: the shell's history doesn't hold the command the tour started it
  // with, so there is nothing the person could run again by a key.
  note: "Its terminal says why. End the tour and take it again.",
})

// Every line the caption box letters, which Nyx's voice-over says, by the key its take is named
// for (`NARRATION.md`, the takes in `voice/`): a step's line by its id and its cue as
// `<id>.cue`, the run without a page's own ending as `play-model`, then the coaches off the story
// and the closing card's.
export const narration = (): ReadonlyMap<string, string> => {
  const lines = new Map<string, string>()
  const add = (key: string, coach: Coach): void => {
    lines.set(key, coach.line)
    if (coach.cue) lines.set(`${key}.cue`, coach.cue.line)
  }
  for (const step of played.page) add(step.id, step.coach)
  add("play-model", modelPlayStep.coach)
  lines.set("screen", screenCoach("startup").line)
  lines.set("team-screen", teamScreenLine)
  add("question", questionCoach)
  add("permission", permissionCoach(""))
  add("ended", endedCoach)
  add("left", leftCoach())
  add("left.team", leftCoach(""))
  lines.set("closing", closingLine)
  return lines
}
