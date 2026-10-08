import { isAgentProgram } from "../../../model/process"
import { createStore } from "../../../model/store"
import type { AgentStatus, AgentTurnEnd, Workspace } from "../../../model/types"
import type { BackendAction, TerminalKey } from "../../port"
import { terminalKeyId } from "../../registry"
import { createDemoAgents } from "./agents"
import { createDebugChat } from "./chat"
import { createDemoFolders } from "./folders"
import { createDemoNotices } from "./notices"
import {
  agentIn,
  agentSays,
  asking,
  backToPrompt,
  cleanExit,
  exitedWithCode,
  failedToStart,
  killedBy,
  othersOf,
  planning,
  rename,
  runAgent,
  runProgram,
  starting,
  terminalOf,
  turnEnded,
  unheardAgent,
  backgroundWork,
  contextOnly,
  finishingSubagents,
  uncountedWork,
  withSubagents,
  withUsage,
  working,
} from "./terminals"
import type {
  DemoAction,
  DemoActionContext,
  DemoActionGroup,
  DemoScreen,
  DemoStates,
} from "./types"

// How long an agent works before its turn ends, so the person can look elsewhere.
const turnMs = 3000
// How long a new terminal takes to fail when it fails "right away".
const quickFailMs = 400
const burst = 30
// How long a screen takes to arrive, and a failed paste's notice stays, as the runner's.
const attachMs = 2500
const noticeMs = 4000

const later = (ms: number, run: () => void): void => void setTimeout(run, ms)

// An action on the selected terminal, or the note that asks for one.
const onSelected = (
  label: string,
  hint: string,
  run: (
    key: TerminalKey,
    context: DemoActionContext & { readonly dispatch: NonNullable<DemoActionContext["dispatch"]> },
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

const agentAction = (
  label: string,
  hint: string,
  status: (now: number) => AgentStatus,
): DemoAction =>
  onSelected(label, hint, (key, { dispatch, workspace }) =>
    dispatch(agentIn(key, terminalOf(workspace(), key), status(Date.now()))),
  )

// Ends the agent's turn a moment later, unless its terminal no longer runs it, as after
// a restart back to the shell.
const endLater = (
  key: TerminalKey,
  outcome: AgentTurnEnd["outcome"],
  {
    dispatch,
    workspace,
  }: Pick<DemoActionContext, "workspace"> & {
    readonly dispatch: NonNullable<DemoActionContext["dispatch"]>
  },
): void =>
  later(turnMs, () => {
    const terminal = terminalOf(workspace(), key)
    if (terminal?.state !== "running" || !isAgentProgram(terminal.process)) return
    dispatch(agentSays(key, turnEnded(outcome, Date.now())))
  })

// The agent works, then its turn ends the way asked.
const endingAction = (outcome: AgentTurnEnd["outcome"], label: string, hint: string): DemoAction =>
  onSelected(label, hint, (key, context) => {
    context.dispatch(agentIn(key, terminalOf(context.workspace(), key), working))
    endLater(key, outcome, context)
  })

// The first live terminal of another project's open session: where an agent can wait or
// finish while the person looks at the project on screen, for the switcher to mark.
const elsewhere = (workspace: Workspace | undefined): TerminalKey | undefined => {
  for (const project of workspace?.projects ?? []) {
    if (project.id === workspace?.activeProjectId) continue
    const session = project.history.find((each) => each.id === project.activeSessionId)
    const terminal = session?.state.roster.terminals.find(
      (each) => each.state !== "exited" && each.state !== "failed",
    )
    if (session && terminal)
      return { projectId: project.id, workspaceSessionId: session.id, terminalId: terminal.id }
  }
  return undefined
}

// An action on a terminal in another project, or the note that asks for one.
const inAnotherProject = (
  label: string,
  hint: string,
  run: (
    key: TerminalKey,
    context: DemoActionContext & { readonly dispatch: NonNullable<DemoActionContext["dispatch"]> },
  ) => void,
): DemoAction => ({
  label,
  hint,
  run: (context) => {
    const key = elsewhere(context.workspace())
    if (!key) return context.note("Add another project with a terminal first.")
    if (!context.dispatch) return
    run(key, { ...context, dispatch: context.dispatch })
  },
})

const elsewhereAgent = (label: string, hint: string, status: AgentStatus): DemoAction =>
  inAnotherProject(label, hint, (key, { dispatch, workspace }) =>
    dispatch(agentIn(key, terminalOf(workspace(), key), status)),
  )

const elsewhereEnding = (outcome: "completed" | "failed", label: string): DemoAction =>
  inAnotherProject(
    label,
    `Works, then ${outcome === "completed" ? "done" : "failed"}: the switcher marks it until you look`,
    (key, context) => {
      context.dispatch(agentIn(key, terminalOf(context.workspace(), key), working))
      endLater(key, outcome, context)
    },
  )

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

// One terminal per state, named after it, so every tab and window shows one at a time.
// The last stays selected; a done mark needs the person to be looking elsewhere, so the
// finished ones come first.
const gallery: readonly {
  readonly name: string
  readonly actions: (key: TerminalKey, now: number) => BackendAction[]
}[] = [
  {
    name: "Finished turn",
    actions: (key, now) => agentIn(key, undefined, turnEnded("completed", now)),
  },
  {
    name: "Failed turn",
    actions: (key, now) => agentIn(key, undefined, turnEnded("failed", now)),
  },
  { name: "Working", actions: (key) => agentIn(key, undefined, working) },
  { name: "Planning", actions: (key) => agentIn(key, undefined, planning) },
  { name: "Subagents", actions: (key) => agentIn(key, undefined, withSubagents) },
  { name: "Asks a question", actions: (key) => agentIn(key, undefined, asking("question", 1)) },
  { name: "Plan ready", actions: (key) => agentIn(key, undefined, asking("plan", 1)) },
  { name: "3 permissions", actions: (key) => agentIn(key, undefined, asking("permission", 3)) },
  { name: "Unheard agent", actions: (key) => unheardAgent(key, "claude") },
  { name: "Running a program", actions: (key) => runProgram(key, "sleep") },
  { name: "Starting", actions: (key) => starting(key) },
  { name: "Idle", actions: () => [] },
  { name: "Exited · code 3", actions: (key) => exitedWithCode(key, 3) },
  { name: "Killed", actions: (key) => killedBy(key, "SIGKILL") },
  { name: "Failed to start", actions: (key) => failedToStart(key, "Folder not found") },
  { name: "Needs permission", actions: (key) => agentIn(key, undefined, asking("permission", 1)) },
]

const everyState: DemoAction = {
  label: "Every state at once",
  hint: `Adds ${gallery.length} terminals, each tab and window in its own state: attention, done, error, ended and more`,
  run: ({ addTerminal, dispatch }) => {
    if (!dispatch) return
    // Added first, so each finish lands while the person looks at the last one.
    const keys = gallery.map(() => addTerminal())
    const now = Date.now()
    dispatch(
      gallery.flatMap(({ name, actions }, index) => {
        const key = keys[index]!
        return [rename(key, name), ...actions(key, now)]
      }),
    )
  },
}

// An agent finishes in a terminal other than the one on screen: the app marks it unread
// and, with the Preferences switch on, notifies.
const finishElsewhere = (outcome: "completed" | "failed"): DemoAction => ({
  label: outcome === "completed" ? "Agent finishes elsewhere" : "Agent fails elsewhere",
  hint: "Another terminal's agent works, then ends its turn: unread mark and notice, if Preferences notifies",
  run: ({ selected, workspace, dispatch, note }) => {
    const current = selected()
    if (!current) return note("Select a terminal first.")
    const other = othersOf(workspace(), current)[0]
    if (!other) return note("Add a second terminal first.")
    if (!dispatch) return
    const key = { ...current, terminalId: other.id }
    dispatch(agentIn(key, other, working))
    endLater(key, outcome, { dispatch, workspace })
  },
})

export const createDemoStates = (): DemoStates => {
  const { agents, openWelcome, failNext: failAgents } = createDemoAgents()
  const { notices, Notices } = createDemoNotices()
  const { pickDirectory, failNext: failPick } = createDemoFolders()
  const chat = createDebugChat()
  const screens = createStore<ReadonlyMap<string, DemoScreen>>(new Map())
  // Sets what a terminal's screen is doing for a while, then shows its output again.
  const showScreen = (key: TerminalKey, screen: DemoScreen, ms: number): void => {
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
  const groups: readonly DemoActionGroup[] = [
    { title: "All at once", actions: [everyState] },
    {
      title: "Selected terminal",
      actions: [
        onSelected("Clean exit", "The tile closes", (key, { dispatch }) =>
          dispatch(cleanExit(key)),
        ),
        onSelected("Exited · code 3", "Ending bar with Restart", (key, { dispatch }) =>
          dispatch(exitedWithCode(key, 3)),
        ),
        onSelected("Exited, no code", "Ending bar without a reason", (key, { dispatch }) =>
          dispatch(exitedWithCode(key, null)),
        ),
        onSelected("Killed · SIGKILL", "Ending bar in the danger tone", (key, { dispatch }) =>
          dispatch(killedBy(key, "SIGKILL")),
        ),
        onSelected(
          "Failed to start · Folder not found",
          "Ending bar, tab marked failed",
          (key, { dispatch }) => dispatch(failedToStart(key, "Folder not found")),
        ),
        onSelected(
          "Starting shell",
          "Tab shows it starting; Starting shell… over the output",
          (key, { dispatch }) => dispatch(starting(key)),
        ),
        onSelected(
          "Loading output",
          "Loading output… over the output for a moment, as after a reconnection",
          (key) => showScreen(key, { attaching: true }, attachMs),
        ),
        onSelected("Paste fails", "A notice at the top for a moment", (key) =>
          showScreen(key, { notice: "Novadeck can't read the clipboard" }, noticeMs),
        ),
        onSelected("Back at the prompt", "A shell, idle", (key, { dispatch }) =>
          dispatch(backToPrompt(key)),
        ),
        onSelected(
          "Run a long program",
          "Footer counts 1 running; closing asks first",
          (key, { dispatch }) => dispatch(runProgram(key, "sleep")),
        ),
        onSelected("Run Claude Code", "The window takes Claude's body", (key, { dispatch }) =>
          dispatch(runAgent(key, "claude")),
        ),
        onSelected("Run Codex", "The window takes Codex's body", (key, { dispatch }) =>
          dispatch(runAgent(key, "codex")),
        ),
      ],
    },
    {
      title: "Agent",
      actions: [
        agentAction("Working", "Tab shows it running", () => working),
        agentAction("Planning", "Working in plan mode", () => planning),
        agentAction("Needs permission", "One request waits", () => asking("permission", 1)),
        agentAction("Asks a question", "One question waits", () => asking("question", 1)),
        agentAction("Plan ready for review", "One plan waits", () => asking("plan", 1)),
        agentAction("3 permissions waiting", "Count in the tab and tooltip", () =>
          asking("permission", 3),
        ),
        agentAction("3 questions waiting", "Count in the tab and tooltip", () =>
          asking("question", 3),
        ),
        agentAction("3 plans waiting", "Count in the tab and tooltip", () => asking("plan", 3)),
        agentAction("Subagents", "Three subagents while it works", () => withSubagents),
        agentAction(
          "Finishing subagents",
          "Two subagents run, mid-turn or after it; it works until they finish",
          () => finishingSubagents,
        ),
        agentAction(
          "Background work",
          "Turn over, 1 agent · 2 tasks run on without it",
          () => backgroundWork,
        ),
        agentAction(
          "Background work, uncounted",
          "Turn over, its harness only says work runs on",
          () => uncountedWork,
        ),
        agentAction("Context and limits", "Usage in its tooltip and status", withUsage),
        agentAction("Context, size unknown", "ctx in tokens, no limits", () => contextOnly),
        endingAction("completed", "Turn completed", "Works, then done when you look elsewhere"),
        endingAction("failed", "Turn failed", "Works, then failed when you look elsewhere"),
        endingAction("interrupted", "Turn interrupted", "Works, then rests; no unread mark"),
        endingAction("unknown", "Turn ended, unknown", "Works, then goes idle with no reply"),
        onSelected(
          "Unheard agent",
          "Claude Code with no word from its hooks",
          (key, { dispatch }) => dispatch(unheardAgent(key, "claude")),
        ),
      ],
    },
    {
      title: "Another project",
      actions: [
        elsewhereAgent(
          "Needs permission",
          "The switcher's dot and row show !",
          asking("permission", 1),
        ),
        elsewhereAgent(
          "Asks a question",
          "The switcher's dot and row show ?",
          asking("question", 1),
        ),
        elsewhereAgent(
          "Plan ready for review",
          "The switcher's dot and row show !",
          asking("plan", 1),
        ),
        elsewhereEnding("completed", "Turn completed"),
        elsewhereEnding("failed", "Turn failed"),
        elsewhereAgent("Working", "A spinner on its row; no dot", working),
        inAnotherProject("Back at the prompt", "Its mark clears", (key, { dispatch }) =>
          dispatch(backToPrompt(key)),
        ),
      ],
    },
    {
      title: "New terminals",
      actions: [
        failingTerminal(
          "Quick failure",
          "A new terminal fails right after starting",
          "Exited right after starting",
          quickFailMs,
        ),
        failingTerminal("Spawn failure", "A new terminal's folder is missing", "Folder not found"),
        failingTerminal(
          "Terminal limit reached",
          "A new terminal is refused",
          "Terminal limit reached",
        ),
        {
          label: `Burst of ${burst}`,
          hint: "Thirty terminals at once",
          run: ({ addTerminal }) => {
            for (let count = 0; count < burst; count += 1) addTerminal()
          },
        },
      ],
    },
    {
      title: "Notices",
      actions: [
        {
          label: "Show a notice",
          hint: "A notification for the selected terminal; click it to reveal the terminal",
          run: ({ selected, note }) => {
            const key = selected()
            if (!key) return note("Select a terminal first.")
            notices.show({
              id: key.terminalId,
              title: "Terminal needs you",
              body: "Click to reveal it.",
            })
          },
        },
        finishElsewhere("completed"),
        finishElsewhere("failed"),
      ],
    },
    {
      title: "Agents",
      actions: [
        {
          label: "Next connect fails",
          hint: "The next switch in Preferences ends in an error",
          run: failAgents,
        },
        {
          label: "Refresh",
          hint: "Looks at the agents again; errors clear",
          run: () => agents.refresh(),
        },
        { label: "Welcome", hint: "Opens the first-run dialog", run: openWelcome },
      ],
    },
    { title: "Chat", actions: chat.actions },
    {
      title: "Folders",
      actions: [
        {
          label: "Next folder pick fails",
          hint: "Open folder rejects instead of asking",
          run: failPick,
        },
      ],
    },
  ]
  return {
    groups,
    agents,
    openWelcome,
    notices,
    pickDirectory,
    chat: chat.wrap,
    screens,
    restart: (key, dispatch) => dispatch(backToPrompt(key)),
    Notices,
  }
}
