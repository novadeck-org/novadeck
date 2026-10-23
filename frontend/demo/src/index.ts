import type { Conversations } from "@novadeck/core/conversation"
import type { InboxItem } from "@novadeck/core/inbox"
import type {
  AgentConnection,
  Backend,
  BackendAction,
  BackendSink,
  MountTerminal,
  TerminalKey,
} from "@novadeck/core/port"
import type { WorkspaceSeed } from "@novadeck/core/seed"
import { createStore } from "@novadeck/core/store"
import {
  createTelemetryStore,
  dropProject,
  dropTerminal,
  noTelemetry,
} from "@novadeck/core/telemetry"
import type { TitleSource, Workspace } from "@novadeck/core/types"

import type { DemoAgentLink } from "./agent-link"
import { babciaIntroOf, createBabcia } from "./babcia"
import { createDemoChat } from "./chat"
import { chirpIntroOf, chirpSeed, chirpTranscripts } from "./chirp"
import { createDemoEngine, type DemoEngine } from "./engine"
import { demoHandle } from "./handles"
import { createDemoInbox, isDemoInbox } from "./inbox"
import { demoInboxItems, demoLetters } from "./inbox-fixtures"
import { checkoutMailboxes, createDemoMessages, isDemoMessages } from "./messages"
import { createDemoMurmur, heldMurmurTiming, requestedMurmur } from "./murmur"
import {
  createMockTerminal,
  defaultName,
  demoFinishes,
  demoSeed,
  demoTelemetry,
  demoTerminalId,
  terminalSlot,
} from "./samples"
import { createShowcase } from "./showcase/simulation"
import { storefrontArtifacts } from "./showcase/storefront"
import { directoryOf, itemsOf } from "./showcase/workspace"
import { withSource } from "./source"
import { terminalOf } from "./terminals"
import { agentTranscripts, type DemoTranscript } from "./transcripts"
import { demoTurns, type DemoTurns } from "./turns"
import { createDemoTerminals, type DemoTerminals, type DemoTerminalSetup } from "./views"
import { createDemoVoice, heldVoiceTiming, requestedVoice } from "./voice"

// Sample agents: Claude Code and Codex installed, Antigravity not.
const sampleAgents: readonly AgentConnection[] = [
  { agent: "claude", available: true, connected: false, busy: false },
  { agent: "codex", available: true, connected: false, busy: false },
  { agent: "agy", available: false, connected: false, busy: false },
]

// A session by its full address: every sample project's session shares one ID.
const addressOf = (projectId: string, sessionId: string) => `${projectId}/${sessionId}`

// What a spec that stops an install asks for in its address's hash: `&install=held`.
const installHeld = (): boolean =>
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("install") === "held"

// Each demo backend's terminals by the mount they serve, which the backends wrapping it keep:
// `withConversations` links them to its agents.
const terminalsOf = new WeakMap<MountTerminal, DemoTerminals>()

// A self-contained backend with sample projects and simulated terminals. It keeps no
// transcripts and connects no agents, but its settings switch like the runner's.
// `welcome` opens the first-run welcome dialog, `seed` is the workspace it opens with, and
// `terminals` says where its terminals draw and what they open with (see `DemoTerminalSetup`).
export const demoBackend = (
  engine: DemoEngine,
  {
    welcome = false,
    seed = demoSeed(Date.now()),
    terminals: setup,
  }: { welcome?: boolean; seed?: WorkspaceSeed; terminals?: DemoTerminalSetup } = {},
): Backend => {
  const terminals = createDemoTerminals(engine, setup)
  const transcripts = createStore(true)
  const agents = createStore(sampleAgents)
  const welcomeOpen = createStore(welcome)
  // Installed unless the address asks otherwise (`&voice=uninstalled`), as the try demo shows it,
  // and an install held at its first step where it asks for that (`&install=held`).
  const held = installHeld()
  const voice = createDemoVoice(held ? heldVoiceTiming : undefined, requestedVoice())
  // Installed unless the address asks otherwise (`&murmur=uninstalled`), as the try demo shows it.
  const murmur = createDemoMurmur(held ? heldMurmurTiming : undefined, requestedMurmur())
  // Standing in for the runner, it numbers each session's terminals itself, never
  // giving a number twice, from the workspace it last saw.
  const numbers = new Map(
    seed.projects.flatMap((project) =>
      project.sessions.map(
        (session) => [addressOf(project.id, session.id), session.terminals.length] as const,
      ),
    ),
  )
  let latest: Workspace | undefined
  const backend: Backend = {
    seed,
    // Every backend built here is the demo's, which shows features still being designed.
    demo: true,
    newTerminal: ({ target, directory, title, launch }) => {
      const session = latest?.projects
        .find((project) => project.id === target.projectId)
        ?.history.find((each) => each.id === target.workspaceSessionId)
      const highest = Math.max(
        0,
        ...(session?.state.roster.terminals ?? []).map((terminal) =>
          Number(terminalSlot(terminal.id)),
        ),
      )
      const address = addressOf(target.projectId, target.workspaceSessionId)
      const number = Math.max(numbers.get(address) ?? highest, highest) + 1
      numbers.set(address, number)
      const terminal = createMockTerminal(target, number, directory, launch?.command)
      return title ? { ...terminal, name: title } : terminal
    },
    commit: (workspace, actions) => {
      // A removed project is forgotten with its sessions' numbering; the engine closes
      // its terminals as it finds them gone.
      const gone = latest?.projects.filter(
        (project) => !workspace.projects.some((each) => each.id === project.id),
      )
      for (const project of gone ?? [])
        for (const session of project.history) numbers.delete(addressOf(project.id, session.id))
      latest = workspace
      engine.reconcile(workspace, actions)
    },
    mountTerminal: terminals.mountTerminal,
    setFont: terminals.setFont,
    // Where the agents say nothing of their usage; `withConversations` gives it the turns'.
    telemetry: createTelemetryStore(),
    voice,
    murmur,
    // Older than every update the demo offers (see debug/states.ts).
    version: () => Promise.resolve("0.0.79"),
    // The demo keeps no logs: Preferences offers the folder as the desktop app does, and
    // opening it does nothing.
    openLogs: () => {},
    // Dictation pastes into the command line, which never submits it.
    typeInto: terminals.typeInto,
    transcripts: {
      enabled: transcripts,
      available: true,
      set: (enabled) => transcripts.update(() => enabled),
    },
    agents: {
      state: agents,
      set: (agent, connected) =>
        agents.update((list) =>
          list.map((item) => (item.agent === agent ? { ...item, connected } : item)),
        ),
      refresh: () => {},
      welcome: welcomeOpen,
      finishWelcome: () => welcomeOpen.update(() => false),
    },
  }
  terminalsOf.set(terminals.mountTerminal, terminals)
  return backend
}

// Starts and stops the terminals of a backend `demoBackend` made, however wrapped: stopped,
// they let their screens, timers and subscriptions go, as a reboot of the debug layer's demo
// leaves them. Nothing for any other backend.
export const demoTerminalsLife = (
  backend: Backend,
): { readonly start: () => void; readonly stop: () => void } | undefined => {
  const terminals = terminalsOf.get(backend.mountTerminal)
  return terminals && { start: terminals.start, stop: terminals.stop }
}

// A window's name handed back: the name of what it shows, as a runner gives it. Nothing
// for an id the workspace holds no window by.
export const windowReset = (
  workspace: Workspace | undefined,
  { projectId, workspaceSessionId, terminalId }: TerminalKey,
): BackendAction[] => {
  const state = workspace?.projects
    .find((project) => project.id === projectId)
    ?.history.find((session) => session.id === workspaceSessionId)?.state
  const window = state?.roster.windows.find((each) => each.id === terminalId)
  const item = window && state?.items.find((each) => each.id === window.itemId)
  if (!window || !item) return []
  return [
    {
      type: "window/upsert",
      target: { projectId, workspaceSessionId },
      window: { ...window, name: item.name, titleSource: { kind: "default" } },
    },
  ]
}

// Who named each sample terminal, and the name Novadeck gives it back on a reset.
const namings: Readonly<
  Record<string, { readonly source: TitleSource; readonly automatic?: string }>
> = {
  "01": { source: { kind: "person" }, automatic: "Checkout flow" },
  "02": { source: { kind: "person" } },
  "03": { source: { kind: "murmur" }, automatic: "Tests" },
  "04": { source: { kind: "agent", by: "moth" }, automatic: "Checkout review" },
  "05": { source: { kind: "person" } },
  "06": { source: { kind: "person" } },
}

// What a reset names a sample terminal: the agent's name for the first, else the
// session's default.
const automaticSource = (slot: string): TitleSource =>
  slot === "01" ? { kind: "agent", by: "moth" } : { kind: "default" }

// The agents demo with messages between its agents: handles, who named each terminal,
// threads in every state, one held for release, and the pause switch.
export const withMessages = (backend: Backend, now: number): Backend => {
  const seed: WorkspaceSeed = {
    ...backend.seed,
    projects: backend.seed.projects.map((project) => ({
      ...project,
      sessions: project.sessions.map((session) => ({
        ...session,
        terminals: session.terminals.map((terminal) => ({
          ...terminal,
          handle: demoHandle(Number(terminalSlot(terminal.id))),
          // The agent that named the checkout review opened it.
          ...(terminalSlot(terminal.id) === "04" ? { ledBy: "moth" } : {}),
          ...(namings[terminalSlot(terminal.id)]
            ? { titleSource: namings[terminalSlot(terminal.id)]!.source }
            : {}),
        })),
      })),
    })),
  }
  const targets = seed.projects.map((project) => ({
    projectId: project.id,
    workspaceSessionId: project.sessions[0]!.id,
  }))
  let sink: BackendSink | undefined
  let latest: Workspace | undefined
  const showcase = createShowcase({ agents: [], directory: (key) => directoryOf(latest, key) })
  return {
    ...backend,
    seed,
    commit: (workspace, actions) => {
      latest = workspace
      backend.commit(workspace, actions)
    },
    // Its terminals show nothing in the pane but their messages, and what the person opens
    // from the Source panel.
    companions: showcase,
    messages: createDemoMessages(checkoutMailboxes(now, targets)),
    resetTitle: (key) => {
      const { projectId, workspaceSessionId, terminalId } = key
      const slot = terminalSlot(terminalId)
      const window = windowReset(latest, key)
      sink?.dispatch(
        window.length
          ? window
          : [
              {
                type: "terminal/update",
                target: { projectId, workspaceSessionId },
                terminalId,
                name: namings[slot]?.automatic ?? defaultName(terminalOf(latest, key)?.command),
                titleSource: automaticSource(slot),
              },
            ],
      )
    },
    start: (next) => {
      sink = next
      const stop = backend.start?.(next)
      const stopShowcase = showcase.start(next.dispatch, () => (latest ? itemsOf(latest) : []))
      return () => {
        stop?.()
        stopShowcase()
        if (sink === next) sink = undefined
      }
    },
  }
}

// A backend with the conversations of its agents, as `transcripts` open them and `turns`
// run what the person sends: the status of each turn goes through the sink it starts with.
// Its terminals' screens read the conversations as the chat does (see `DemoAgentLink`), as
// `demoBackend`'s, which it must wrap, are linked here;
// `wrap` gives both the same conversations, for a demo whose agents act on what they are
// told, so a prompt or an answer from the screen reaches them as one from the chat.
export const withConversations = (
  backend: Backend,
  transcripts: Readonly<Record<string, DemoTranscript>>,
  turns: DemoTurns,
  wrap: (conversations: Conversations) => Conversations = (conversations) => conversations,
): Backend => {
  const chat = createDemoChat(backend.seed, transcripts, turns)
  const conversations = wrap(chat.conversations)
  const link: DemoAgentLink = {
    conversations,
    opening: chat.opening,
  }
  const terminals = terminalsOf.get(backend.mountTerminal)
  if (!terminals) throw new Error("withConversations wraps a backend demoBackend made")
  terminals.link(link)
  const linked: Backend = {
    ...backend,
    conversations,
    telemetry: turns.telemetry,
    commit: (workspace, actions) => {
      backend.commit(workspace, actions)
      chat.observe(workspace)
      // A closed terminal's agent says no more, nor those of a removed project.
      for (const action of actions) {
        if (action.type === "terminal/close")
          turns.telemetry.update((held) =>
            dropTerminal(
              held,
              `${action.target.projectId}/${action.target.workspaceSessionId}`,
              action.terminalId,
            ),
          )
        // The reducer keeps the last project, so only one gone from the workspace is dropped.
        if (
          action.type === "project/remove" &&
          !workspace.projects.some((project) => project.id === action.projectId)
        )
          turns.telemetry.update((held) => dropProject(held, action.projectId))
      }
    },
    start: (sink) => {
      const stopTurns = turns.start(sink)
      const stop = backend.start?.(sink)
      return () => {
        stop?.()
        stopTurns()
      }
    },
  }
  return linked
}

// A backend with the demo's Inbox (see `createDemoInbox`): what its agents wait on, from the
// conversations and messages `backend` has, which `withConversations` gave it, and `items`
// over them, the demo's own. Answering one of those for an agent that waits takes the agent
// past it, to wait for the person's next words. Its messages keep a record of what the
// person answered, where they are the demo's.
export const withInbox = (
  backend: Backend,
  turns: DemoTurns,
  items: readonly InboxItem[] = [],
): Backend => {
  const { conversations, messages } = backend
  if (!conversations) throw new Error("withInbox wraps a backend withConversations made")
  const record = isDemoMessages(messages) ? messages.record : undefined
  const inbox = createDemoInbox(Date.now(), items, record, {
    conversations,
    messages,
    resume: (key, terminal) => turns.resume(key, terminal, { waits: true }),
  })
  return { ...backend, inbox }
}

// The agents demo's storefront terminals hold what their agents showed, on their bars,
// to open, peek at and move. What the person opens from the Source panel joins them.
export const withStorefrontArtifacts = (backend: Backend): Backend => {
  let latest: Workspace | undefined
  const session = { projectId: "storefront", workspaceSessionId: "initial" }
  const showcase = createShowcase({
    agents: [],
    shown: Object.entries(storefrontArtifacts).map(([slot, artifacts]) => ({
      key: { ...session, terminalId: demoTerminalId(session, Number(slot)) },
      handle: demoHandle(Number(slot)),
      artifacts,
    })),
    directory: (key) => directoryOf(latest, key),
  })
  return {
    ...backend,
    companions: showcase,
    commit: (workspace, actions) => {
      latest = workspace
      backend.commit(workspace, actions)
    },
    seed: {
      ...backend.seed,
      projects: backend.seed.projects.map((project) =>
        project.id !== session.projectId
          ? project
          : {
              ...project,
              sessions: project.sessions.map((each) =>
                each.id === session.workspaceSessionId ? { ...each, items: showcase.items } : each,
              ),
            },
      ),
    },
    start: (sink) => {
      const stop = backend.start?.(sink)
      const stopShowcase = showcase.start(sink.dispatch, () =>
        latest ? itemsOf(latest) : showcase.items,
      )
      return () => {
        stop?.()
        stopShowcase()
      }
    },
  }
}

// How long after the agents demo opens its agents in other projects finish.
const finishAfterMs = 2500

// The agents demo, whose agents in design-system and infra end their turn a moment after
// it opens (see `demoFinishes`), so the switcher marks their projects done and failed.
const withFinishes = (backend: Backend, turns: DemoTurns): Backend => ({
  ...backend,
  start: (sink) => {
    const stop = backend.start?.(sink)
    for (const { projectId, terminalId, outcome } of demoFinishes)
      turns.finish(
        { projectId, workspaceSessionId: "initial", terminalId },
        backend.seed.projects
          .find((project) => project.id === projectId)
          ?.sessions.find((session) => session.id === "initial")
          ?.terminals.find((terminal) => terminal.id === terminalId),
        outcome,
        { after: finishAfterMs },
      )
    return () => stop?.()
  },
})

// The demos with no content showcase: the plain one, the agents', the agents' with
// messages between them, the agents' with every kind of Inbox item, the plain one with its
// first-run welcome dialog open, and Chirp's and Babcia's, one-offs for videos (see `chirp.ts`
// and `babcia.ts`). Each has
// the Inbox its agents make; the Inbox demo shows the hardcoded items of every kind over theirs.
// The agents', messages' and Inbox demos have the Source of the storefront project (see
// `source.ts`), as the try demo does: the others have no agents there to change files.
export type PlainVariant =
  | "plain"
  | "agents"
  | "messages"
  | "inbox"
  | "welcome"
  | "chirp"
  | "babcia"

export const plainDemo = (
  variant: PlainVariant,
  terminals?: DemoTerminalSetup,
  turnMs?: number,
  turns: DemoTurns = demoTurns(turnMs),
): Backend => {
  // Every agent takes a prompt, works a moment, and finishes, however it is sent; the
  // seeds and the debug panel drive the same turns.
  const backend = demoBackend(createDemoEngine(), {
    welcome:
      variant === "welcome" ||
      (import.meta.env.DEV && import.meta.env.VITE_WELCOME_PREVIEW === "true"),
    // Chirp's and Babcia's agents open on their own work (see `chirp.ts` and `babcia.ts`).
    ...(variant === "chirp"
      ? { terminals: { ...terminals, introOf: chirpIntroOf } }
      : variant === "babcia"
        ? { terminals: { ...terminals, introOf: babciaIntroOf } }
        : terminals && { terminals }),
  })
  const now = Date.now()
  turns.telemetry.update(() =>
    variant === "plain" || variant === "welcome" || variant === "chirp" || variant === "babcia"
      ? noTelemetry
      : demoTelemetry(now),
  )
  if (variant === "chirp")
    return withInbox(
      withConversations({ ...backend, seed: chirpSeed(now) }, chirpTranscripts(now), turns),
      turns,
    )
  if (variant === "babcia") {
    const babcia = createBabcia(turns, now)
    return babcia.over(
      withInbox(
        withConversations(babcia.under(backend), babcia.transcripts, turns, babcia.wrap),
        turns,
      ),
    )
  }
  const transcripts = agentTranscripts(now)
  if (variant === "messages")
    return withSource(
      withInbox(
        withConversations(
          withFinishes(withMessages({ ...backend, seed: demoSeed(now, true) }, now), turns),
          transcripts,
          turns,
        ),
        turns,
        demoLetters(now),
      ),
      turns,
    )
  const conversing = withConversations(
    variant === "agents" || variant === "inbox"
      ? withFinishes(withStorefrontArtifacts({ ...backend, seed: demoSeed(now, true) }), turns)
      : backend,
    transcripts,
    turns,
  )
  // Only where the storefront's terminals run agents: the plain and welcome shells don't.
  if (variant === "plain" || variant === "welcome") return withInbox(conversing, turns)
  if (variant === "agents") return withSource(withInbox(conversing, turns), turns)
  return withSource(
    withInbox({ ...conversing, messages: createDemoMessages([]) }, turns, demoInboxItems(now)),
    turns,
  )
}

// The variant the address's hash asks for, as specs do with `?demo=`, and how long an
// agent's turn works with `&turnMs=`, as a spec does that must act on the screen before
// the turn ends, which a busy machine may not in the usual 1.5 s. `terminals` is where
// they draw, as specs give them the page's theme.
export const createDemoBackend = (terminals?: DemoTerminalSetup): Backend => {
  const params = new URLSearchParams(window.location.hash.split("?")[1])
  const demo = params.get("demo")
  const turnMs = Number(params.get("turnMs"))
  const backend = plainDemo(
    demo === "agents" || demo === "messages" || demo === "inbox" || demo === "welcome"
      ? demo
      : "plain",
    terminals,
    turnMs > 0 ? turnMs : undefined,
  )
  if (isDemoInbox(backend.inbox)) {
    const answer = params.get("inboxAnswer")
    if (answer === "failed") backend.inbox.failNext()
    if (answer === "stale") backend.inbox.failNext("That ask is no longer available.")
  }
  return backend
}
