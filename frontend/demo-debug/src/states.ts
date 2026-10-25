import type { Inbox } from "@novadeck/core/inbox"
import type { BackendAction, TerminalKey } from "@novadeck/core/port"
import { isAgentProgram } from "@novadeck/core/process"
import { terminalKeyId } from "@novadeck/core/registry"
import { createStore } from "@novadeck/core/store"
import { terminalAsks } from "@novadeck/core/terminal-ending"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import type { DemoAgentVerbs, DemoWaiting } from "@novadeck/demo/agent-link"
import type { DemoScreenState } from "@novadeck/demo/runtime"
import { terminalOf } from "@novadeck/demo/terminals"

import { createDemoAgents } from "./agents"
import { createDebugChat } from "./chat"
import { createDemoFolders } from "./folders"
import { createDemoNotices } from "./notices"
import {
  agentRanHere,
  backToPrompt,
  cleanExit,
  contextOnly,
  dealKinds,
  exitedWithCode,
  failedToStart,
  killedBy,
  killedForMemory,
  leadsNext,
  leadsOthers,
  murmurGists,
  noisyAgents,
  openedByAgent,
  othersOf,
  otherTerminals,
  promptTerminals,
  rename,
  runAgent,
  runProgram,
  starting,
  unheardAgent,
  withUsage,
} from "./terminals"
import type { DemoAction, DemoActionContext, DemoActionGroup, DemoStates } from "./types"
import { createDemoUpdates } from "./updates"

// How long an agent works before its turn ends, so the person can look elsewhere.
const turnMs = 3000
// How long a new terminal takes to fail when it fails "right away".
const quickFailMs = 400
const burst = 30
// How many terminals Fill the Inbox takes: enough to pass the badge's 9+ and to scroll.
const crowd = 12
// How long clearing waits between the agents working and resting, for the app to see both.
const calmMs = 100
// How long a screen takes to arrive, as the runner's.
const attachMs = 2500

// The second round of kinds reads as murmur wrote it, the first as it never ran.
const murmured = (index: number): boolean =>
  index >= terminalAsks.length && index < 2 * terminalAsks.length

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const later = (ms: number, run: () => void): void => void setTimeout(run, ms)

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
  { workspace, note }: DemoActionContext,
  usage: Parameters<DemoAgentVerbs["usage"]>[2],
): void => {
  const terminal = terminalOf(workspace(), key)
  if (terminal?.state === "running" && !terminal.agent && isAgentProgram(terminal.process))
    return note("Novadeck hears nothing from this agent, so it has no usage to show.")
  verbs.usage(key, terminal, usage)
}

// An action of the agent group: a verb on whichever terminal the group's target names.
const verb = (label: string, hint: string, run: Verbed, verbs: DemoAgentVerbs): DemoAction => ({
  label,
  hint,
  run: (context) => {
    const key = targetOf(context)
    if (key) run(verbs, key, terminalOf(context.workspace(), key))
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

// One terminal per state, named after it, so every tab and window shows one at a time.
// The last stays selected; a done mark needs the person to be looking elsewhere, so the
// finished ones come first, ending their turns a moment later. An agent's state is its
// verb's, the rest the terminal's metadata.
const gallery: readonly {
  readonly name: string
  readonly state?: (key: TerminalKey) => BackendAction[]
  readonly agent?: (verbs: DemoAgentVerbs, key: TerminalKey) => void
}[] = [
  {
    name: "Finished turn",
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
  { name: "Unheard agent", state: (key) => unheardAgent(key, "claude") },
  { name: "Running a program", state: (key) => runProgram(key, "sleep") },
  { name: "Opened by an agent", state: (key) => openedByAgent(key, "pnpm") },
  { name: "Agent exited", state: (key) => agentRanHere(key) },
  { name: "Starting", state: (key) => starting(key) },
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

const everyState = (verbs: DemoAgentVerbs): DemoAction => ({
  label: "Every state at once",
  hint: `${gallery.length} terminals, one per state`,
  run: ({ addTerminal, dispatch }) => {
    if (!dispatch) return
    // Added first, so each finish lands while the person looks at the last one.
    const keys = gallery.map(() => addTerminal())
    gallery.forEach(({ state }, index) => state && verbs.release(keys[index]!))
    dispatch(
      gallery.flatMap(({ name, state }, index) => {
        const key = keys[index]!
        return [rename(key, name), ...(state?.(key) ?? [])]
      }),
    )
    gallery.forEach(({ agent }, index) => agent?.(verbs, keys[index]!))
  },
})

// What fills the Inbox with waiting agents and clears it of them, over the verbs.
const createWaitingActions = (
  verbs: DemoAgentVerbs,
  inbox: () => Inbox | undefined,
): readonly [DemoAction, DemoAction] => {
  // Every kind of wait and finish across the workspace's projects and sessions, in terminals
  // the person doesn't view. Takes up to `crowd` terminals, adding some to the session on
  // screen when the workspace has fewer, without selecting them or leaving the panel the
  // person is on. A request waits at once; each finish lands as the agent ends its turn,
  // while the person looks elsewhere.
  const fillInbox: DemoAction = {
    label: "Fill the Inbox",
    hint: `${crowd} terminals ask or finish; the Inbox badge reads 9+`,
    run: ({ selected, workspace, addInBackground, dispatch, note }) => {
      const viewed = selected()
      if (!viewed) return note("Select a terminal first.")
      if (!dispatch) return
      const existing = otherTerminals(workspace(), viewed).slice(0, crowd)
      const added = Array.from({ length: Math.max(0, crowd - existing.length) }, () =>
        addInBackground(viewed),
      )
      const slots = [...existing, ...added]
      const kinds = dealKinds(slots.length)
      slots.forEach((key, index) => {
        const kind = kinds[index]!
        const terminal = terminalOf(workspace(), key)
        const murmur = murmured(index)
        if (kind === "done" || kind === "failed")
          verbs.finish(key, terminal, kind === "done" ? "completed" : "failed", {
            after: turnMs,
            ...(murmur ? { gist: murmurGists[kind] } : {}),
          })
        else verbs.ask(key, terminal, kind, 1)
      })
    },
  }

  // Answers every request and reads every finish: the Inbox reads the finishes it stored, and
  // each agent works for a moment, then rests, which also calls off a finish still to come. A
  // terminal back at its shell's prompt may hold a finish too, so an agent works there and
  // leaves again.
  const clearWaiting: DemoAction = {
    label: "Clear waiting agents",
    hint: "Answers and reads everything; the Inbox empties of what agents wait on",
    run: ({ workspace, dispatch }) => {
      if (!dispatch) return
      inbox()?.readFinishes?.(
        (workspace()?.projects ?? []).flatMap((project) =>
          project.history.flatMap((session) =>
            session.state.roster.terminals.map((terminal) => ({
              context: `${project.id}/${session.id}`,
              terminalId: terminal.id,
            })),
          ),
        ),
      )
      const agents = noisyAgents(workspace())
      const prompts = promptTerminals(workspace()).map((key) => ({
        key,
        shell: terminalOf(workspace(), key)?.process ?? "zsh",
      }))
      for (const key of [...agents, ...prompts.map((each) => each.key)])
        verbs.work(key, terminalOf(workspace(), key))
      later(calmMs, () => {
        for (const key of agents) {
          const terminal = terminalOf(workspace(), key)
          if (terminal?.state === "running" && isAgentProgram(terminal.process))
            verbs.rest(key, terminal)
        }
        for (const { key, shell } of prompts) {
          const terminal = terminalOf(workspace(), key)
          if (terminal?.state !== "running" || !isAgentProgram(terminal.process)) continue
          verbs.rest(key, terminal)
          dispatch(backToPrompt(key, shell))
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
  const { agents, openWelcome, failNext: failAgents, limitAntigravity } = createDemoAgents()
  const { notices, Notices } = createDemoNotices()
  const updateControls = createDemoUpdates()
  const { updates, offer, whatsNew } = updateControls
  const { pickDirectory, failNext: failPick } = createDemoFolders()
  const chat = createDebugChat()
  const waitingActions = createWaitingActions(verbs, inbox)
  const screens = createStore<ReadonlyMap<string, DemoScreenState>>(new Map())
  // The terminals whose next pasted file fails to save.
  const pasteFails = new Set<string>()
  // Sets what a terminal's screen is doing for a while, then shows its output again.
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
        onSelected(
          "Leads the others",
          "Every other terminal joins its team; the wire joins them on the rail, in Grid and Canvas",
          (key, { dispatch, workspace, note }) => {
            const actions = leadsOthers(workspace(), key)
            if (!actions.length) return note("It needs a handle and other terminals to lead.")
            dispatch(actions)
            if (
              !["idle", "running", "finished"].includes(terminalOf(workspace(), key)?.state ?? "")
            )
              note("They name it as their lead, but a lead leads only while it runs.")
          },
        ),
        onSelected(
          "Leads the next one",
          "The next live terminal leaves any team for this one's; on two terminals apart, Grid and Canvas wire two teams",
          (key, { dispatch, workspace, note }) => {
            const actions = leadsNext(workspace(), key)
            if (!actions.length)
              return note("It needs a handle and a live terminal after it to lead.")
            dispatch(actions)
            if (
              !["idle", "running", "finished"].includes(terminalOf(workspace(), key)?.state ?? "")
            )
              note("The next one names it as its lead, but a lead leads only while it runs.")
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
      actions: [
        everyState(verbs),
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
            const target = { projectId: key.projectId, workspaceSessionId: key.workspaceSessionId }
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
      actions: [
        verb("Work", "Working; tab shows it running", (v, k, t) => v.work(k, t), verbs),
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
          "Works, then done; unread once you look away",
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
          "Back at its prompt; answered, read, nothing running",
          (v, k, t) => v.rest(k, t),
          verbs,
        ),
      ],
    },
    {
      section: "Agents",
      title: "Agent fixtures",
      actions: [
        setting("Unheard agent", "Claude Code, its hooks silent", (key, { dispatch }) =>
          dispatch(unheardAgent(key, "claude")),
        ),
        onSelected(
          "Context and limits",
          "Usage in tooltip and status; all else stays",
          (key, context) => usageOf(verbs, key, context, withUsage(Date.now())),
        ),
        onSelected("Context, no size", "Tokens only, no limits; all else stays", (key, context) =>
          usageOf(verbs, key, context, contextOnly),
        ),
      ],
    },
    {
      section: "Agents",
      title: "Waiting agents",
      actions: [...waitingActions],
    },
    {
      section: "Agents",
      title: "Chat: next send or Stop fails",
      actions: chat.actions,
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
    notices,
    updates,
    whatsNew,
    offer,
    updateControls,
    pickDirectory,
    chat: chat.wrap,
    screens,
    failPaste: (key) => pasteFails.delete(terminalKeyId(key)),
    restart: (key, dispatch) => {
      verbs.release(key)
      dispatch(backToPrompt(key))
    },
    Notices,
  }
}
