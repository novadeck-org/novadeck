import { finishGraceMs } from "@novadeck/core/agents/finish"
import type { AgentName } from "@novadeck/core/harnesses"
import type { Inbox, InboxEntry } from "@novadeck/core/inbox"
import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"
import { isAgentProgram } from "@novadeck/core/terminals/process"
import { terminalKeyId } from "@novadeck/core/terminals/registry"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import type { DemoAgentVerbs, DemoShell, DemoWaiting } from "@novadeck/demo/agents/link"
import { isDemoInbox } from "@novadeck/demo/inbox"
import type { DemoScreenState } from "@novadeck/demo/terminals/runtime"
import { terminalOf } from "@novadeck/demo/workspace"

import { createDemoAgents } from "./agents"
import { createChatFailures, createChatPictures } from "./chat"
import { createDemoUpdates, pageUpdateChannel } from "./desktop/updates"
import { createEmptyChats } from "./emptiness"
import { createDemoFolders } from "./folders"
import { createStaleMentions } from "./mentions"
import { createNewerChat } from "./newer"
import { createDemoNotices } from "./notices"
import {
  atStartupScreen,
  agentRanHere,
  backToPrompt,
  cleanExit,
  contextOnly,
  dealKinds,
  doneReport,
  exitedWithCode,
  failedToStart,
  isLive,
  sessionTarget,
  killedBy,
  killedForMemory,
  mcpAsk,
  leadsNext,
  leadsOthers,
  noisyAgents,
  openedByAgent,
  othersOf,
  otherTerminals,
  rename,
  runAgent,
  runProgram,
  sleeping,
  starting,
  waking,
  unheardAgent,
  withModelLimits,
  withUsage,
} from "./terminals"
import type { DemoAction, DemoActionContext, DemoActionGroup, DemoStates } from "./types"

// How long an agent works before its turn ends, so the person can look elsewhere.
const turnMs = 3000
// How long an agent that "writes its words" takes to, after the question it asked.
const askWordsMs = 6000
// How long a new terminal takes to fail when it fails "right away".
const quickFailMs = 400
const burst = 30
// How many terminals Fill the Inbox takes: enough to scroll.
const crowd = 12
// Of those, the ones that wait on the person; the rest report done, as Updates.
const crowdWaits = dealKinds(crowd).filter((kind) => kind !== "done").length
// How long clearing waits between the agents working and resting, for the app to see both.
const calmMs = 100
// How long an agent that sleeps after a turn keeps running past its end: the Inbox entry of a
// completed turn is stored only once it has stood for `finishGraceMs`, while its terminal
// still runs the agent.
const sinceTurnEndMs = finishGraceMs + calmMs
const sleepAfterMs = turnMs + sinceTurnEndMs
// How long ago the "Asleep, done" tile's agent finished, so its tab shows an age.
const doneAgoMs = 4 * 60_000
// How long a screen takes to arrive, as the runner's.
const attachMs = 2500

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const later = (ms: number, run: () => void): void => void setTimeout(run, ms)

// The longest `afterTold` waits for the Inbox to store a turn's entry.
const toldCapMs = 10_000

// Runs `run` once the Inbox has stored the entry of the turn `key`'s agent ends from now: its
// terminal's tab reads that entry as unread, and a terminal put to sleep before it is stored
// (a completed turn's waits out `finishGraceMs` while its terminal still runs the agent) has
// none. Where the Inbox keeps no turns, or none comes, it runs after `sleepAfterMs`, or the cap.
const afterTold = (inbox: () => Inbox | undefined, key: TerminalKey, run: () => void): void => {
  const turns = inbox()?.turns
  if (!turns) return later(sleepAfterMs, run)
  const since = Date.now()
  let stop: (() => void) | undefined
  let cap: ReturnType<typeof setTimeout> | undefined
  const go = (): void => {
    clearTimeout(cap)
    stop?.()
    // Not inside the store's own notification: the dispatch it makes is its own commit.
    later(0, run)
  }
  cap = setTimeout(go, toldCapMs)
  stop = turns.subscribe(() => {
    const told = turns
      .getSnapshot()
      ?.some(
        (entry) =>
          entry.projectId === key.projectId &&
          entry.workspaceSessionId === key.workspaceSessionId &&
          entry.terminalId === key.terminalId &&
          entry.at >= since,
      )
    if (told) go()
  })
}

// An action on the selected terminal, or the note that asks for one.
const onSelected = (
  label: string,
  hint: string,
  run: (
    key: TerminalKey,
    context: DemoActionContext & {
      readonly dispatch: NonNullable<DemoActionContext["dispatch"]>
    },
  ) => void,
): DemoAction => ({
  label,
  hint,
  run: (context) => {
    const key = context.selected()
    if (!key) return context.note("Select a terminal first.")
    if (!context.dispatch) return
    run(key, { ...context, dispatch: context.dispatch })
  },
})

// An action that makes the selected terminal lead others, with the notes for when it can
// lead none, and for a lead whose shell doesn't run, which the others name but which leads
// no one yet.
const leading = (
  label: string,
  hint: string,
  leads: (workspace: Workspace | undefined, key: TerminalKey) => BackendAction[],
  notes: { readonly none: string; readonly notRunning: string },
): DemoAction =>
  onSelected(label, hint, (key, { dispatch, workspace, note }) => {
    const actions = leads(workspace(), key)
    if (!actions.length) return note(notes.none)
    dispatch(actions)
    if (!["idle", "running", "finished"].includes(terminalOf(workspace(), key)?.state ?? ""))
      note(notes.notRunning)
  })

// The first live terminal of another project's open session: where an agent can wait or
// finish while the person looks at the project on screen, for the switcher to mark.
const elsewhere = (workspace: Workspace | undefined): TerminalKey | undefined => {
  for (const project of workspace?.projects ?? []) {
    if (project.id === workspace?.activeProjectId) continue
    const session = project.history.find((each) => each.id === project.activeSessionId)
    const terminal = session?.state.roster.terminals.find(isLive)
    if (session && terminal)
      return {
        projectId: project.id,
        workspaceSessionId: session.id,
        terminalId: terminal.id,
      }
  }
  return undefined
}

// The terminal the group's target names, or the note that asks for what it needs. The
// other terminal of the session is added in the background when it has none, which the
// workspace doesn't hold yet, so the verb makes it an agent from nothing.
const targetOf = (context: DemoActionContext): TerminalKey | undefined => {
  if (context.target === "project") {
    const key = elsewhere(context.workspace())
    if (!key) context.note("Add another project with a terminal first.")
    return key
  }
  const current = context.selected()
  if (!current) return void context.note("Select a terminal first.")
  if (context.target === "selected") return current
  const other = othersOf(context.workspace(), current)[0]
  return other ? { ...current, terminalId: other.id } : context.addInBackground(current)
}

// What an agent verb is called with: the terminal it acts on and the verbs.
type Verbed = (
  verbs: DemoAgentVerbs,
  key: TerminalKey,
  terminal: TerminalMetadata | undefined,
) => void

// Sets the selected terminal's usage, which an agent Novadeck hears nothing from can't show.
const usageOf = (
  verbs: DemoAgentVerbs,
  key: TerminalKey,
  { workspace, note, harness }: DemoActionContext,
  usage: Parameters<DemoAgentVerbs["usage"]>[2],
): void => {
  const terminal = terminalOf(workspace(), key)
  if (terminal?.state === "running" && !terminal.agent && isAgentProgram(terminal.process))
    return note("Novadeck hears nothing from this agent, so it has no usage to show.")
  verbs.as(harness).usage(key, terminal, usage)
}

// An action of the agent group: a verb on whichever terminal the group's target names.
const verb = (label: string, hint: string, run: Verbed, verbs: DemoAgentVerbs): DemoAction => ({
  label,
  hint,
  run: (context) => {
    const key = targetOf(context)
    if (key) run(verbs.as(context.harness), key, terminalOf(context.workspace(), key))
  },
})

// A terminal that is added and then fails to start.
const failingTerminal = (label: string, hint: string, message: string, wait = 0): DemoAction => ({
  label,
  hint,
  run: ({ addTerminal, dispatch }) => {
    const key = addTerminal()
    dispatch?.(starting(key))
    later(wait, () => dispatch?.(failedToStart(key, message)))
  },
})

// What the waiting states wait on: a CI watch that has run 4 minutes, and a wake-up due in 8.
const waitingOnJob: DemoWaiting = {
  job: { description: "Watch CI checks for PR #436", command: "gh pr checks 436 --watch" },
  minutes: 4,
}
const waitingForWake: DemoWaiting = {
  wake: { reason: "Check the deploy" },
  inMinutes: 8,
}
// A wake-up a week off, which a tab says by the days to it, not the clock.
const waitingForWeekWake: DemoWaiting = {
  wake: { reason: "Check the deploy" },
  inMinutes: 7 * 24 * 60,
}

// The background shells the shell states leave running, and for how long they have.
const oneShell: readonly DemoShell[] = [{ command: "pnpm dev --filter storefront", minutes: 4 }]
const manyShells: readonly DemoShell[] = [
  { command: "pnpm dev --filter storefront", minutes: 12 },
  { command: "tail -f logs/api.log", minutes: 7 },
  { command: "docker compose up postgres", minutes: 3 },
]

// The shells the item's states are reached with: one that failed (its output ends in the error),
// one that ended without trouble, one that was stopped, one whose output Novadeck can't read
// (run in a terminal of the agent's own), one whose file can't be read just now, one that has
// only just started, and one whose output went with its session.
const failedShell: DemoShell = {
  command: "docker compose up postgres",
  minutes: 3,
  ended: { code: 1, ago: 1 },
}
const doneShell: DemoShell = {
  command: "pnpm build --filter storefront",
  minutes: 2,
  ended: { code: 0, ago: 1 },
}
const stoppedShell: DemoShell = { command: "sleep 600", minutes: 5, ended: { code: null, ago: 2 } }
const elsewhereShell: DemoShell = { command: "npm run seed", minutes: 2, output: "none" }
const lockedShell: DemoShell = { command: "make watch", minutes: 2, output: "unreadable" }
// Started this moment: with nothing to read yet, it says so for its first 5 s.
const newShell: DemoShell = { command: "npm run seed", minutes: 0, output: "none" }
const clearedShell: DemoShell = {
  command: "pytest -x tests/api",
  minutes: 30,
  ended: { code: 0, ago: 20 },
  output: "gone",
}
const failedShells: readonly DemoShell[] = [manyShells[0]!, manyShells[1]!, failedShell]
// Past what one screen holds: every state of a shell, some of them twice, and a running one with
// output of its own to unfold.
const crowdOfShells: readonly DemoShell[] = [
  ...manyShells,
  failedShell,
  { ...failedShell, command: "pnpm test --filter api", minutes: 9 },
  doneShell,
  stoppedShell,
  elsewhereShell,
  lockedShell,
  clearedShell,
  { command: "pnpm lint --watch", minutes: 1 },
]

// How long from now the gallery's paused agent's usage limit resets, and a limit's that is
// days off, which a tab says by the days to it, not the clock.
const limitResetMs = 80 * 60_000
const farLimitResetMs = 8 * 86_400_000

// One terminal per state, named after it, so every tab and window shows one at a time.
// The last stays selected; a done mark needs the person to be looking elsewhere, so the
// finished ones come first, ending their turns a moment later. An agent's state is its
// verb's, the rest the terminal's metadata; what an agent asks through its MCP `ask` is an
// Inbox entry of the demo's own, added once the terminal is in its state.
const gallery: readonly {
  readonly name: string
  readonly state?: (key: TerminalKey, harness: AgentName) => BackendAction[]
  readonly agent?: (verbs: DemoAgentVerbs, key: TerminalKey) => void
  readonly asks?: "text" | "action"
  // What the terminal becomes once its agent's turn has ended: the agent is let go, and
  // these dispatched, so its turn's Inbox entry stays while the agent sleeps.
  readonly after?: (key: TerminalKey, harness: AgentName) => BackendAction[]
}[] = [
  {
    name: "Done",
    agent: (verbs, key) =>
      verbs.finish(key, undefined, "completed", { after: turnMs, done: doneReport }),
  },
  {
    name: "Replied, unread",
    agent: (verbs, key) => verbs.finish(key, undefined, "completed", { after: turnMs }),
  },
  {
    name: "Failed turn",
    agent: (verbs, key) => verbs.finish(key, undefined, "failed", { after: turnMs }),
  },
  { name: "Working", agent: (verbs, key) => verbs.work(key, undefined) },
  {
    name: "Planning",
    agent: (verbs, key) => verbs.work(key, undefined, { planning: true }),
  },
  {
    name: "Subagents",
    agent: (verbs, key) => verbs.work(key, undefined, { subagents: true }),
  },
  {
    name: "Shell running",
    agent: (verbs, key) =>
      verbs.finish(key, undefined, "completed", { after: turnMs, shells: oneShell }),
  },
  {
    name: "3 shells running",
    agent: (verbs, key) =>
      verbs.finish(key, undefined, "completed", { after: turnMs, shells: manyShells }),
  },
  {
    name: "Shells, one failed",
    agent: (verbs, key) =>
      verbs.finish(key, undefined, "completed", { after: turnMs, shells: failedShells }),
  },
  {
    name: "Many shells",
    agent: (verbs, key) =>
      verbs.finish(key, undefined, "completed", { after: turnMs, shells: crowdOfShells }),
  },
  {
    name: "Asks a question",
    agent: (verbs, key) => verbs.ask(key, undefined, "question", 1),
  },
  {
    name: "Plan ready",
    agent: (verbs, key) => verbs.ask(key, undefined, "plan", 1),
  },
  {
    name: "3 permissions",
    agent: (verbs, key) => verbs.ask(key, undefined, "permission", 3),
  },
  {
    name: "Waiting on a job",
    agent: (verbs, key) =>
      verbs.finish(key, undefined, "completed", { after: turnMs, waiting: waitingOnJob }),
  },
  {
    name: "Waiting for a wake-up",
    agent: (verbs, key) =>
      verbs.finish(key, undefined, "completed", { after: turnMs, waiting: waitingForWake }),
  },
  {
    name: "Waiting, wakes in 7 days",
    agent: (verbs, key) =>
      verbs.finish(key, undefined, "completed", { after: turnMs, waiting: waitingForWeekWake }),
  },
  {
    name: "Working, a side question",
    agent: (verbs, key) => verbs.work(key, undefined),
    asks: "text",
  },
  {
    name: "Paused at its limit",
    agent: (verbs, key) =>
      verbs.finish(key, undefined, "failed", {
        after: turnMs,
        error: "Usage limit reached",
        limit: { minutes: 300, resetsAt: Date.now() + limitResetMs },
      }),
  },
  {
    name: "Paused, resets in 8 days",
    agent: (verbs, key) =>
      verbs.finish(key, undefined, "failed", {
        after: turnMs,
        error: "Usage limit reached",
        limit: { minutes: 10_080, resetsAt: Date.now() + farLimitResetMs },
      }),
  },
  {
    name: "Paused at a model's limit",
    agent: (verbs, key) =>
      verbs.finish(key, undefined, "failed", {
        after: turnMs,
        error: "You've hit your Fable weekly limit",
        limit: { minutes: 10_080, resetsAt: Date.now() + 2 * 86_400_000, scope: "Fable" },
      }),
  },
  { name: "Asks (MCP)", state: (key, harness) => runAgent(key, harness), asks: "text" },
  { name: "Needs a sign-in", state: (key, harness) => runAgent(key, harness), asks: "action" },
  { name: "Unheard agent", state: (key, harness) => unheardAgent(key, harness) },
  { name: "At its startup screen", state: (key, harness) => atStartupScreen(key, harness) },
  { name: "Running a program", state: (key) => runProgram(key, "sleep") },
  { name: "Opened by an agent", state: (key) => openedByAgent(key, "pnpm") },
  { name: "Agent exited", state: (key) => agentRanHere(key) },
  { name: "Starting", state: (key) => starting(key) },
  { name: "Asleep", state: (key, harness) => sleeping(key, harness) },
  { name: "Asleep, newer agent", state: (key) => sleeping(key, "newer") },
  {
    name: "Asleep, done",
    state: (key, harness) => sleeping(key, harness, true, Date.now() - doneAgoMs),
  },
  {
    name: "Asleep, asks (MCP)",
    state: (key, harness) => sleeping(key, harness),
    asks: "text",
  },
  {
    name: "Asleep, reply unread",
    agent: (verbs, key) => verbs.finish(key, undefined, "completed", { after: turnMs }),
    after: (key, harness) => sleeping(key, harness, false, Date.now() - sinceTurnEndMs),
  },
  {
    name: "Asleep, stopped with an error",
    agent: (verbs, key) => verbs.finish(key, undefined, "failed", { after: turnMs }),
    after: (key, harness) => sleeping(key, harness, false, Date.now() - sinceTurnEndMs),
  },
  { name: "Waking", state: (key, harness) => waking(key, harness) },
  {
    name: "Waking, asks (MCP)",
    state: (key, harness) => waking(key, harness),
    asks: "text",
  },
  { name: "Idle" },
  { name: "Exit code 3", state: (key) => exitedWithCode(key, 3) },
  { name: "Killed", state: (key) => killedBy(key, "SIGKILL") },
  {
    name: "Failed to start",
    state: (key) => failedToStart(key, "Folder not found"),
  },
  {
    name: "Needs permission",
    agent: (verbs, key) => verbs.ask(key, undefined, "permission", 1),
  },
]

// The ids of the MCP asks the panel opened, which Clear withdraws; the variant's own stay.
type PanelAsks = Set<string>

// Whether an entry is a done report one of the demo's agents wrote, as `inbox.done` names it,
// not an Update entry of the variant's own.
const agentDone = (entry: InboxEntry): boolean =>
  entry.kind === "update" && entry.update.type === "done" && entry.id.startsWith("entry:demo-done-")

// Marks the terminal a set of actions puts to sleep as one the panel holds asleep, and hands
// the actions back.
type Hold = (key: TerminalKey, actions: BackendAction[]) => BackendAction[]

const everyState = (
  verbs: DemoAgentVerbs,
  inbox: () => Inbox | undefined,
  panelAsks: PanelAsks,
  hold: Hold,
): DemoAction => ({
  label: "Every state at once",
  hint: `${gallery.length} terminals, one per state`,
  run: ({ addTerminal, dispatch, workspace, harness }) => {
    if (!dispatch) return
    // Added first, so each finish lands while the person looks at the last one.
    const keys = gallery.map(() => addTerminal())
    gallery.forEach(({ state }, index) => state && verbs.release(keys[index]!))
    dispatch(
      gallery.flatMap(({ name, state }, index) => {
        const key = keys[index]!
        return [rename(key, name), ...hold(key, state?.(key, harness) ?? [])]
      }),
    )
    const agents = verbs.as(harness)
    gallery.forEach(({ agent }, index) => agent?.(agents, keys[index]!))
    gallery.forEach(({ after }, index) => {
      if (!after) return
      const key = keys[index]!
      afterTold(inbox, key, () => {
        verbs.release(key)
        dispatch(hold(key, after(key, harness)))
      })
    })
    const own = inbox()
    if (!isDemoInbox(own)) return
    gallery.forEach(({ asks }, index) => {
      const entry = asks && mcpAsk(workspace(), keys[index]!, asks, Date.now(), harness)
      if (!entry) return
      own.add(entry)
      panelAsks.add(entry.id)
    })
  },
})

// What fills the Inbox with waiting agents and clears it of them, over the verbs.
const createWaitingActions = (
  verbs: DemoAgentVerbs,
  inbox: () => Inbox | undefined,
  panelAsks: PanelAsks,
): readonly [DemoAction, DemoAction] => {
  // Every kind of wait and finish across the workspace's projects and sessions, in terminals
  // the person doesn't view. Takes up to `crowd` terminals, adding some to the session on
  // screen when the workspace has fewer, without selecting them or leaving the panel the
  // person is on. A request waits at once; each finish lands as the agent ends its turn,
  // while the person looks elsewhere.
  const fillInbox: DemoAction = {
    label: "Fill the Inbox",
    hint: `${crowd} terminals ask or finish: ${crowdWaits} wait in the Inbox, ${crowd - crowdWaits} report done as Updates`,
    run: ({ selected, workspace, addInBackground, dispatch, note, harness }) => {
      const viewed = selected()
      if (!viewed) return note("Select a terminal first.")
      if (!dispatch) return
      const agents = verbs.as(harness)
      const existing = otherTerminals(workspace(), viewed).slice(0, crowd)
      const added = Array.from({ length: Math.max(0, crowd - existing.length) }, () =>
        addInBackground(viewed),
      )
      const slots = [...existing, ...added]
      const kinds = dealKinds(slots.length)
      slots.forEach((key, index) => {
        const kind = kinds[index]!
        const terminal = terminalOf(workspace(), key)
        if (kind === "done" || kind === "failed")
          agents.finish(key, terminal, kind === "done" ? "completed" : "failed", {
            after: turnMs,
            // A done agent called `done`; a failed one only stopped.
            ...(kind === "done" ? { done: doneReport } : {}),
          })
        else agents.ask(key, terminal, kind, 1)
      })
    },
  }

  // Answers every request and reads every finish: the Inbox reads the finishes it stored and
  // the done reports its agents wrote, the MCP asks the panel opened are withdrawn and
  // cleared, and each agent works for a moment, then rests, which also calls off a finish
  // still to come. A terminal back at its shell's prompt holds nothing more: its marks are its
  // stored entries'. The variant's own entries stay, for the Inbox group's actions.
  const clearWaiting: DemoAction = {
    label: "Clear waiting agents",
    hint: "Answers and reads everything; the Inbox empties of what agents wait on",
    run: ({ workspace, dispatch }) => {
      if (!dispatch) return
      const own = inbox()
      own?.readFinishes?.(
        (workspace()?.projects ?? []).flatMap((project) =>
          project.history.flatMap((session) =>
            session.state.roster.terminals.map((terminal) => ({
              context: `${project.id}/${session.id}`,
              terminalId: terminal.id,
            })),
          ),
        ),
      )
      if (isDemoInbox(own)) {
        const { items, answering } = own.state.getSnapshot()
        for (const entry of items.filter(agentDone))
          own.answer(entry.id, { kind: "update", action: "read" })
        // An ask being answered goes as answered.
        const asks = items
          .filter((entry) => panelAsks.has(entry.id) && !entry.settled && !answering[entry.id])
          .map((entry) => entry.id)
        for (const id of asks) own.resolve(id, "withdrawn")
        for (const id of asks) panelAsks.delete(id)
      }
      const agents = noisyAgents(workspace())
      for (const key of agents) verbs.work(key, terminalOf(workspace(), key))
      later(calmMs, () => {
        for (const key of agents) {
          const terminal = terminalOf(workspace(), key)
          if (terminal?.state === "running" && isAgentProgram(terminal.process))
            verbs.rest(key, terminal)
        }
      })
    },
  }

  return [fillInbox, clearWaiting]
}

export const createDemoStates = (
  verbs: DemoAgentVerbs,
  inbox: () => Inbox | undefined = () => undefined,
): DemoStates => {
  const {
    agents,
    openWelcome,
    openWelcomeBare,
    failNext: failAgents,
    limitAntigravity,
  } = createDemoAgents()
  const { notices, Notices } = createDemoNotices()
  const updateControls = createDemoUpdates(undefined, pageUpdateChannel)
  const { updates, offer, whatsNew } = updateControls
  const { pickDirectory, failNext: failPick } = createDemoFolders()
  // The next move of a terminal to another session is refused, as a runner refuses one.
  let refuseMove = false
  const moveTerminal: DemoStates["moveTerminal"] = (move) => (key, sessionId, undo) => {
    if (!refuseMove) return move(key, sessionId, undo)
    refuseMove = false
    return Promise.reject(new Error("The runner is restarting it, so it stays where it is."))
  }
  const chat = createChatFailures()
  const pictures = createChatPictures()
  const mentions = createStaleMentions()
  const newerChat = createNewerChat()
  const emptyChats = createEmptyChats()
  const panelAsks: PanelAsks = new Set()
  const waitingActions = createWaitingActions(verbs, inbox, panelAsks)
  const screens = createStore<ReadonlyMap<string, DemoScreenState>>(new Map())
  // The terminals whose next pasted file fails to save.
  const pasteFails = new Set<string>()
  // The sleepers the panel set, which stay asleep, whoever looks.
  const held = new Set<string>()
  const hold: Hold = (key, actions) => {
    // Where the actions leave it: `waking` passes through sleeping on its way.
    const last = actions.findLast((action) => action.type === "terminal/status")
    if (last?.type === "terminal/status" && last.status.state === "sleeping")
      held.add(terminalKeyId(key))
    return actions
  }
  // Sets what a terminal's screen is doing for a while, then shows its output again.
  // Another window holds the terminal's keyboard, idle or typing, until this one takes it.
  const observe = (key: TerminalKey, observed: "idle" | "typing"): void => {
    const id = terminalKeyId(key)
    screens.update((all) => new Map(all).set(id, { ...all.get(id), observed }))
  }
  const showScreen = (key: TerminalKey, screen: DemoScreenState, ms: number): void => {
    const id = terminalKeyId(key)
    screens.update((all) => new Map(all).set(id, screen))
    later(ms, () =>
      screens.update((all) => {
        if (all.get(id) !== screen) return all
        const next = new Map(all)
        next.delete(id)
        return next
      }),
    )
  }
  // An action on the selected terminal that sets its state some other way than through an
  // agent verb, so what its agent had pending is called off first.
  const setting: typeof onSelected = (label, hint, run) =>
    onSelected(label, hint, (key, context) => {
      verbs.release(key)
      run(key, context)
    })
  // The agent ends a turn, then sleeps with the turn's Inbox entry standing.
  const sleepsAfter = (label: string, outcome: "completed" | "failed", hint: string) =>
    onSelected(label, hint, (key, { dispatch, harness, workspace }) => {
      verbs.finish(key, terminalOf(workspace(), key), outcome, { after: turnMs })
      afterTold(inbox, key, () => {
        verbs.release(key)
        dispatch(hold(key, sleeping(key, harness, false, Date.now() - sinceTurnEndMs)))
      })
    })
  const groups: readonly DemoActionGroup[] = [
    {
      section: "Terminals",
      title: "Selected terminal",
      actions: [
        setting("Starting shell", "Tab and screen show it starting", (key, { dispatch }) =>
          dispatch(starting(key)),
        ),
        onSelected("Loading output", "Briefly, as after a reconnect", (key) =>
          showScreen(key, { attaching: true }, attachMs),
        ),
        onSelected(
          "Another window has the keyboard",
          "The screen shows the other window's size under a “Typing in another window · Take over” strip; plain typing takes the keyboard and goes through, Enter or a Ctrl key takes it and says so",
          (key) => observe(key, "idle"),
        ),
        onSelected(
          "Another window is typing",
          "As above while the other window types: a key shows the strip's busy form and goes nowhere, and only Take over takes the keyboard",
          (key) => observe(key, "typing"),
        ),
        setting(
          "Asleep",
          "The agent has a saved session and no process",
          (key, { dispatch, harness }) => dispatch(hold(key, sleeping(key, harness))),
        ),
        setting(
          "Asleep, a newer Novadeck's agent",
          "The agent belongs to a harness only a newer Novadeck knows: its tab shows it asleep and this build never wakes it, whoever looks",
          (key, { dispatch }) => dispatch(hold(key, sleeping(key, "newer"))),
        ),
        setting("Waking", "Its agent is on the way back", (key, { dispatch, harness }) =>
          dispatch(waking(key, harness)),
        ),
        sleepsAfter(
          "Asleep, reply unread",
          "completed",
          "Replies, then sleeps; brightened until you look",
        ),
        sleepsAfter(
          "Asleep, stopped with an error",
          "failed",
          "Fails, then sleeps; unread once you look away",
        ),
        setting("At the prompt", "Idle shell", (key, { dispatch }) => dispatch(backToPrompt(key))),
        setting("Long program", "Counts as running; closing asks first", (key, { dispatch }) =>
          dispatch(runProgram(key, "sleep")),
        ),
        setting("Claude Code", "Window switches to Claude", (key, { dispatch }) =>
          dispatch(runAgent(key, "claude")),
        ),
        setting("Codex", "Window switches to Codex", (key, { dispatch }) =>
          dispatch(runAgent(key, "codex")),
        ),
        setting("Antigravity", "Window switches to Antigravity", (key, { dispatch }) =>
          dispatch(runAgent(key, "agy")),
        ),
        leading(
          "Leads the others",
          "Every other terminal joins its team; the wire joins them on the rail, in Grid and Canvas",
          leadsOthers,
          {
            none: "It needs a handle and other terminals to lead.",
            notRunning: "They name it as their lead, but a lead leads only while it runs.",
          },
        ),
        leading(
          "Leads the next one",
          "The next live terminal leaves any team for this one's; on two terminals apart, Grid and Canvas wire two teams",
          leadsNext,
          {
            none: "It needs a handle and a live terminal after it to lead.",
            notRunning: "The next one names it as its lead, but a lead leads only while it runs.",
          },
        ),
        onSelected("Paste fails", "The next pasted file, with a notice", (key) => {
          pasteFails.add(terminalKeyId(key))
        }),
        setting("Clean exit", "Tile closes", (key, { dispatch }) => dispatch(cleanExit(key))),
        setting("Exit code 3", "Ending bar with Restart", (key, { dispatch }) =>
          dispatch(exitedWithCode(key, 3)),
        ),
        setting("Exit, no code", "Ending bar, no reason", (key, { dispatch }) =>
          dispatch(exitedWithCode(key, null)),
        ),
        setting("Killed (SIGKILL)", "Ending bar, danger tone", (key, { dispatch }) =>
          dispatch(killedBy(key, "SIGKILL")),
        ),
        setting("Killed for memory", "Ending bar: Killed · out of memory", (key, { dispatch }) =>
          dispatch(killedForMemory(key)),
        ),
        setting("Failed to start", "Folder not found; tab marked failed", (key, { dispatch }) =>
          dispatch(failedToStart(key, "Folder not found")),
        ),
      ],
    },
    {
      section: "Terminals",
      title: "New terminals",
      harnesses: true,
      actions: [
        everyState(verbs, inbox, panelAsks, hold),
        failingTerminal(
          "Quick failure",
          "Fails right after starting",
          "Exited right after starting",
          quickFailMs,
        ),
        failingTerminal("Spawn failure", "Its folder is missing", "Folder not found"),
        failingTerminal("Terminal limit", "New terminal refused", "Terminal limit reached"),
        {
          label: `Burst of ${burst}`,
          hint: `${burst} terminals at once`,
          run: ({ addTerminal }) => {
            for (let count = 0; count < burst; count += 1) addTerminal()
          },
        },
      ],
    },
    {
      section: "Terminals",
      title: "Projects and sessions",
      actions: [
        {
          label: "Fresh session, process running",
          hint: "Open Sessions: the old one counts 1 running",
          run: async ({ selected, dispatch, note, startFresh }) => {
            const key = selected()
            if (!key || !dispatch) return note("Select a terminal first.")
            const target = sessionTarget(key)
            verbs.release(key)
            dispatch([
              {
                type: "terminal/status",
                target,
                terminalId: key.terminalId,
                status: { state: "running" },
              },
              { type: "terminal/process", target, terminalId: key.terminalId, process: "sleep" },
            ])
            await pause(1_000)
            startFresh()
          },
        },
        {
          label: "Next move refused",
          hint: "Moving a terminal to another session fails; a toast says why",
          run: () => {
            refuseMove = true
          },
        },
        {
          label: "Folder pick fails",
          hint: "Next Open folder rejects without asking",
          run: failPick,
        },
      ],
    },
    {
      section: "Agents",
      title: "Agent",
      targets: true,
      harnesses: true,
      actions: [
        verb("Work", "Working; tab shows it running", (v, k, t) => v.work(k, t), verbs),
        {
          label: "Asks, words in 6 s",
          hint: "The agent works and asks (MCP) in the viewed terminal: the ask shows in the Inbox list, but the bell, the app badge and the tab's ? wait for its words, 6 s on (or the turn's end, or 15 s)",
          run: (context) => {
            const key = targetOf(context)
            if (!key) return
            verbs.as(context.harness).work(key, terminalOf(context.workspace(), key), {
              says: askWordsMs,
            })
            const own = inbox()
            const entry = mcpAsk(context.workspace(), key, "text", Date.now(), context.harness)
            if (!entry || !isDemoInbox(own)) return
            own.add(entry)
            panelAsks.add(entry.id)
          },
        },
        verb(
          "Plan mode",
          "Working in plan mode",
          (v, k, t) => v.work(k, t, { planning: true }),
          verbs,
        ),
        verb(
          "Subagents",
          "3 subagents while working",
          (v, k, t) => v.work(k, t, { subagents: true }),
          verbs,
        ),
        verb(
          "Many tool calls",
          "Works through 12 calls, one every 0.7 s; the chat keeps the latest 5 in a box that follows them",
          (v, k, t) => v.work(k, t, { tools: 12 }),
          verbs,
        ),
        verb(
          "Needs permission",
          "1 request waiting; answering it clears it",
          (v, k, t) => v.ask(k, t, "permission", 1),
          verbs,
        ),
        verb(
          "Asks a question",
          "1 question waiting",
          (v, k, t) => v.ask(k, t, "question", 1),
          verbs,
        ),
        verb("Plan ready", "1 plan waiting", (v, k, t) => v.ask(k, t, "plan", 1), verbs),
        verb(
          "3 permissions",
          "Count in tab and tooltip",
          (v, k, t) => v.ask(k, t, "permission", 3),
          verbs,
        ),
        verb(
          "Completes",
          "Works, then calls done; the done mark stands once you look away, plus an Update entry",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, done: doneReport }),
          verbs,
        ),
        verb(
          "Replies, no done call",
          "Works, then rests; its program brightens until you look, no Inbox entry",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs }),
          verbs,
        ),
        verb(
          "Fails",
          "Works, then failed; unread once you look away",
          (v, k, t) => v.finish(k, t, "failed", { after: turnMs }),
          verbs,
        ),
        verb(
          "Interrupted",
          "Works, then stops with a short reply; no unread mark",
          (v, k, t) => v.finish(k, t, "interrupted", { after: turnMs }),
          verbs,
        ),
        verb(
          "Ends without reply",
          "Works, then idles with no reply",
          (v, k, t) => v.finish(k, t, "unknown", { after: turnMs }),
          verbs,
        ),
        verb(
          "Background work",
          "Turn over; 2 tasks run on, counted",
          (v, k, t) =>
            v.finish(k, t, "completed", { after: turnMs, background: { agents: 0, tasks: 2 } }),
          verbs,
        ),
        verb(
          "Background, uncounted",
          "Turn over; work runs on, uncounted",
          (v, k, t) =>
            v.finish(k, t, "completed", { after: turnMs, background: { agents: 0, tasks: 0 } }),
          verbs,
        ),
        verb(
          "Finishing subagents",
          "Works on until its 2 subagents finish",
          (v, k, t) =>
            v.finish(k, t, "completed", { after: turnMs, background: { agents: 2, tasks: 0 } }),
          verbs,
        ),
        verb(
          "Shell running",
          "Turn over; one background shell runs on, under the chat's working line",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, shells: oneShell }),
          verbs,
        ),
        verb(
          "3 shells running",
          "Turn over; three background shells run on, folded into one line",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, shells: manyShells }),
          verbs,
        ),
        verb(
          "Shells, one failed",
          "Turn over; two shells run on and a third failed: the Shells item's failed entry is tinted and offers to tell the agent, and the chat's shell lines show each one's last line",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, shells: failedShells }),
          verbs,
        ),
        verb(
          "Shell ended ok",
          "Turn over; the only shell exited 0: the Shells item stays, its entry muted",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, shells: [doneShell] }),
          verbs,
        ),
        verb(
          "Shell stopped",
          "Turn over; the only shell was stopped, with no exit code: the entry says stopped, its output empty",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, shells: [stoppedShell] }),
          verbs,
        ),
        verb(
          "Shell output elsewhere",
          "Turn over; a shell the agent ran where Novadeck can't read its output (Codex: in a terminal of its own): its entry says so",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, shells: [elsewhereShell] }),
          verbs,
        ),
        verb(
          "Shell output unreadable",
          "Turn over; a shell whose output file is there and can't be read just now: its entry says its output can't be read just now",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, shells: [lockedShell] }),
          verbs,
        ),
        verb(
          "Shell just started",
          "Turn over; a shell that started this moment, with nothing of its output to read: its entry says No output yet, and after 5 s that Novadeck can't read it",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, shells: [newShell] }),
          verbs,
        ),
        verb(
          "Shells, none listed",
          "Turn over; the agent's status lists an empty set of shells, which the runner never keeps an item for: the Shells item stays, saying the agent has no background shells now",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, shells: [] }),
          verbs,
        ),
        verb(
          "Shell output gone",
          "Turn over; a shell whose output went with the agent's session: its entry says it is gone",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, shells: [clearedShell] }),
          verbs,
        ),
        verb(
          "Many shells",
          "Turn over; ten shells in every state: the Shells item lists failed first, then running, then ended",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, shells: crowdOfShells }),
          verbs,
        ),
        verb(
          "Working, 3 shells",
          "Works with three background shells under the working line",
          (v, k, t) => v.work(k, t, { shells: manyShells }),
          verbs,
        ),
        verb(
          "Waiting on a job",
          "Turn over; waits on a command it started",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, waiting: waitingOnJob }),
          verbs,
        ),
        verb(
          "Waiting for a wake-up",
          "Turn over; waits for a wake-up it set",
          (v, k, t) => v.finish(k, t, "completed", { after: turnMs, waiting: waitingForWake }),
          verbs,
        ),
        verb(
          "Rest",
          "Back at its prompt; answered, nothing running; Inbox entries it wrote stay",
          (v, k, t) => v.rest(k, t),
          verbs,
        ),
      ],
    },
    {
      section: "Agents",
      title: "Agent fixtures",
      harnesses: true,
      actions: [
        setting(
          "Unheard agent",
          "The chosen harness, its hooks silent",
          (key, { dispatch, harness }) => dispatch(unheardAgent(key, harness)),
        ),
        setting(
          "At its startup screen",
          "The chosen harness held at a trust or update screen: the tab's need mark, no Inbox entry",
          (key, { dispatch, harness }) => dispatch(atStartupScreen(key, harness)),
        ),
        setting(
          "At its sign-in screen",
          "Antigravity held at sign-in: the tab's need mark, no Inbox entry",
          (key, { dispatch }) => dispatch(atStartupScreen(key, "agy", "sign-in")),
        ),
        setting(
          "Signed out at its prompt",
          "Claude Code bound at its prompt, whose footer says it isn't signed in: the need mark, the chat gives way",
          (key, { dispatch }) => dispatch(atStartupScreen(key, "claude", "sign-in")),
        ),
        setting(
          "Hooks not trusted",
          "Codex at its hooks review, or its prompt with them skipped: the need mark, the words to trust them",
          (key, { dispatch }) => dispatch(atStartupScreen(key, "codex", "hooks")),
        ),
        setting(
          "Hooks off in settings",
          "The chosen harness with Novadeck's hooks off in the person's settings: the need mark, what it means",
          (key, { dispatch, harness }) => dispatch(atStartupScreen(key, harness, "hooks")),
        ),
        onSelected(
          "Context and limits",
          "Usage in tooltip and status; all else stays",
          (key, context) => usageOf(verbs, key, context, withUsage(Date.now())),
        ),
        onSelected(
          "Context and model limits",
          "Usage with a model's own weekly windows (Fable, Third-party) beside the account's; all else stays",
          (key, context) => usageOf(verbs, key, context, withModelLimits(Date.now())),
        ),
        onSelected("Context, no size", "Tokens only, no limits; all else stays", (key, context) =>
          usageOf(verbs, key, context, contextOnly),
        ),
      ],
    },
    {
      section: "Agents",
      title: "Waiting agents",
      harnesses: true,
      actions: [...waitingActions],
    },
    {
      section: "Agents",
      title: "Chat: next send or Stop fails",
      actions: chat.actions,
    },
    {
      section: "Agents",
      title: "Chat: pictures of recorded prompts",
      actions: pictures.actions,
    },
    {
      section: "Agents",
      title: "Chat: nothing to show",
      actions: emptyChats.actions,
    },
    {
      section: "Agents",
      title: "Chat: a handle given again",
      actions: mentions.actions,
    },
    {
      section: "Agents",
      title: "Chat: a newer Novadeck's words",
      actions: newerChat.actions,
    },
    {
      section: "Agents",
      title: "Agent connections",
      actions: [
        {
          label: "Connect fails",
          hint: "Next switch in Preferences errors",
          run: failAgents,
        },
        {
          label: "Refresh",
          hint: "Rechecks agents; errors clear",
          run: () => agents.refresh(),
        },
        {
          label: "Antigravity limited",
          hint: "Connected, with a warning in Preferences",
          run: limitAntigravity,
        },
      ],
    },
  ]
  return {
    groups,
    agents,
    openWelcome,
    openWelcomeBare,
    notices,
    updates,
    whatsNew,
    offer,
    updateControls,
    pickDirectory,
    moveTerminal,
    chat: (conversations) =>
      emptyChats.wrap(newerChat.wrap(mentions.wrap(pictures.wrap(chat.wrap(conversations))))),
    screens,
    failPaste: (key) => pasteFails.delete(terminalKeyId(key)),
    holds: (key) => held.has(terminalKeyId(key)),
    took: (key) =>
      screens.update((all) => {
        const id = terminalKeyId(key)
        const state = all.get(id)
        if (!state?.observed) return all
        const next = new Map(all)
        const { observed: _, ...rest } = state
        if (Object.keys(rest).length > 0) next.set(id, rest)
        else next.delete(id)
        return next
      }),
    restart: (key, dispatch) => {
      verbs.release(key)
      dispatch(backToPrompt(key))
    },
    Notices,
  }
}
