import {
  createTelemetryStore,
  dropProject,
  dropTerminal,
  noTelemetry,
} from "@novadeck/core/agents/telemetry"
import type { Conversations } from "@novadeck/core/conversation"
import type { InboxRow } from "@novadeck/core/inbox"
import { emptyCompanions, itemIdOf, type Item } from "@novadeck/core/items"
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
import type { TitleSource, Workspace } from "@novadeck/core/types"

import { createDemoMurmur, heldMurmurTiming, requestedMurmur } from "./addons/murmur"
import { createDemoVoice, heldVoiceTiming, requestedVoice } from "./addons/voice"
import { createDemoChat } from "./agents/chat"
import type { DemoAgentLink } from "./agents/link"
import { agentTranscripts, type DemoTranscript } from "./agents/transcripts"
import { demoTurns, type DemoTurns } from "./agents/turns"
import { withFeedback } from "./feedback"
import { demoHandle } from "./handles"
import { createDemoInbox, isDemoInbox } from "./inbox"
import { demoInboxRows, demoEntries, demoPlanStates } from "./inbox/fixtures"
import { inboxLeadMessages, inboxTranscripts, withInboxLead } from "./inbox/transcripts"
import { checkoutMessages, createDemoMessages, isDemoMessages } from "./messages"
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
import { checkoutPlan, storefrontArtifacts } from "./showcase/storefront"
import { withSource } from "./source"
import { createDemoEngine, type DemoEngine } from "./terminals/engine"
import { createDemoTerminals, type DemoTerminals, type DemoTerminalSetup } from "./terminals/views"
import { babciaIntroOf, createBabcia } from "./videos/babcia"
import { chirpIntroOf, chirpSeed, chirpTranscripts } from "./videos/chirp"
import { createLaunch } from "./videos/launch"
import { directoryOf, itemsOf, terminalOf } from "./workspace"

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
    // Older than every update the demo offers (see demo-debug's `updates.ts`).
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
    messages: createDemoMessages(checkoutMessages(now, targets)),
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
  items: readonly InboxRow[] = [],
): Backend => {
  const { conversations, messages } = backend
  if (!conversations) throw new Error("withInbox wraps a backend withConversations made")
  const record = isDemoMessages(messages) ? messages.record : undefined
  const inbox = createDemoInbox(Date.now(), items, record, {
    conversations,
    messages,
    resume: (key, terminal) => turns.resume(key, terminal, { waits: true }),
  })
  // An agent that ends its turn calling `done` reports through the Inbox.
  turns.watch((event) => {
    if (event.type === "end" && event.done) inbox.done(event.key, event.done)
    // The person's own prompt to an agent takes its open asks out of the Inbox, as the
    // runner's does: only a turn begun on their words carries a prompt, not an Inbox
    // button's fixed line.
    if (event.type === "begin" && event.prompt !== undefined && !event.automatic)
      inbox.withdrawAsks(event.key, event.submittedAt ?? Date.now())
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

// A plan approval comes with its plan, as each harness shows the plan it asks about as it
// asks: when one reaches the Inbox, the plan on its terminal's bar is shown again, at the
// approval's time, for the sheet to find it the runner's way. A terminal with none yet, as
// the agents' own Claude Code planning in each showcased project's first terminal, is shown
// the checkout plan, whose content this backend serves itself.
export const withPlanShows = (backend: Backend): Backend => {
  const { inbox } = backend
  if (!inbox) return backend
  const companions = backend.companions ?? emptyCompanions()
  let latest: Workspace | undefined
  return {
    ...backend,
    companions: {
      ...companions,
      follow: (target, itemId, options, on) => {
        if (!itemId.startsWith(demoPlanPrefix))
          return companions.follow(target, itemId, options, on)
        // A plan shown for the loading state never has its content.
        if (!itemId.endsWith(loadingSuffix)) on(checkoutPlan.content)
        return () => {}
      },
    },
    commit: (workspace, actions) => {
      latest = workspace
      backend.commit(workspace, actions)
    },
    start: (sink) => {
      const stop = backend.start?.(sink)
      const shown = new Set<string>()
      const look = (): void => {
        for (const row of inbox.state.getSnapshot().items) {
          if (row.kind !== "request" || row.request.kind !== "plan" || shown.has(row.id)) continue
          shown.add(row.id)
          // Its plan is never shown: the box waits, then the dialog's words stand in.
          if (row.id === demoPlanStates.missing) continue
          const { projectId, workspaceSessionId, terminalId, handle } = row.source
          const role = row.request.subagent ? "subagent" : "root"
          const loading = row.id === demoPlanStates.loading
          const plan = (latest ? itemsOf(latest) : seedItems(backend.seed)).find(
            (item) =>
              !loading &&
              item.kind === "plan" &&
              item.from?.terminalId === terminalId &&
              item.plan?.role === role,
          )
          sink.dispatch([
            {
              type: "item/upsert",
              target: { projectId, workspaceSessionId },
              item: plan
                ? { ...plan, version: plan.version + 1, shownAt: row.at }
                : demoPlanItem(terminalId, handle, role, row.at, loading ? loadingSuffix : ""),
            },
          ])
        }
      }
      look()
      const stopInbox = inbox.state.subscribe(look)
      return () => {
        stopInbox()
        stop?.()
      }
    },
  }
}

const demoPlanPrefix = "demo-plan-"

// The id ending of a plan whose content never comes.
const loadingSuffix = "-loading"

// The checkout plan, shown on terminal `terminalId`'s bar at `at`.
const demoPlanItem = (
  terminalId: string,
  handle: string,
  role: "root" | "subagent",
  at: number,
  suffix: string,
): Item => ({
  ...checkoutPlan.item,
  id: itemIdOf(`${demoPlanPrefix}${terminalId}${role === "subagent" ? "-subagent" : ""}${suffix}`),
  holder: { terminalId },
  by: "agent",
  from: { terminalId, handle },
  version: 1,
  openAsked: false,
  shownAt: at,
  plan: { agent: "Claude Code", role, source: "file" },
})

const seedItems = (seed: WorkspaceSeed): readonly Item[] =>
  seed.projects.flatMap((project) => project.sessions.flatMap((each) => each.items))

// How long after the agents demo opens its agents in other projects finish.
const finishAfterMs = 2500

// The agents demo, whose agents in design-system and infra end their turn a moment after
// it opens (see `demoFinishes`), so the switcher marks their projects done and failed.
const withFinishes = (backend: Backend, turns: DemoTurns): Backend => ({
  ...backend,
  start: (sink) => {
    const stop = backend.start?.(sink)
    for (const { projectId, terminalId, outcome } of demoFinishes) {
      const found = backend.seed.projects
        .find((project) => project.id === projectId)
        ?.sessions.find((session) => session.id === "initial")
        ?.terminals.find((terminal) => terminal.id === terminalId)
      turns.finish({ projectId, workspaceSessionId: "initial", terminalId }, found, outcome, {
        after: finishAfterMs,
        ...(outcome === "completed"
          ? {
              done: {
                subject: `${found?.name ?? "The agent"} is done`,
                body: "Everything asked is in, and the checks pass.",
              },
            }
          : {}),
      })
    }
    return () => stop?.()
  },
})

// The demos with no content showcase: the plain one, the agents', the agents' with
// messages between them, the agents' with every kind of Inbox item, the plain one with its
// first-run welcome dialog open, and Chirp's, Babcia's and Launch's, one-offs for videos (see
// `videos/chirp.ts`, `videos/babcia.ts` and `videos/launch.ts`). Each has
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
  | "launch"

export const plainDemo = (
  variant: PlainVariant,
  terminals?: DemoTerminalSetup,
  turnMs?: number,
  turns: DemoTurns = demoTurns(turnMs),
): Backend => {
  const backend = plainBackend(variant, terminals, turns)
  // The cues of Babcia and Launch are kept by the backend their own wrapper returns: their
  // feedback joins inside.
  return variant === "babcia" || variant === "launch" ? backend : withFeedback(backend, turns)
}

const plainBackend = (
  variant: PlainVariant,
  terminals: DemoTerminalSetup | undefined,
  turns: DemoTurns,
): Backend => {
  const now = Date.now()
  // Launch's agents print more as the video goes on, so its screens come from the demo itself.
  const launch = variant === "launch" ? createLaunch(turns, now) : undefined
  // Every agent takes a prompt, works a moment, and finishes, however it is sent; the
  // seeds and the debug panel drive the same turns.
  const backend = demoBackend(createDemoEngine(), {
    welcome:
      variant === "welcome" ||
      (import.meta.env.DEV && import.meta.env.VITE_WELCOME_PREVIEW === "true"),
    // Chirp's, Babcia's and Launch's agents open on their own work (see `videos/`).
    ...(variant === "chirp"
      ? { terminals: { ...terminals, introOf: chirpIntroOf } }
      : variant === "babcia"
        ? { terminals: { ...terminals, introOf: babciaIntroOf } }
        : launch
          ? { terminals: { ...terminals, introOf: launch.introOf } }
          : terminals && { terminals }),
  })
  turns.telemetry.update(() =>
    variant === "plain" ||
    variant === "welcome" ||
    variant === "chirp" ||
    variant === "babcia" ||
    variant === "launch"
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
      withFeedback(
        withInbox(
          withConversations(babcia.under(backend), babcia.transcripts, turns, babcia.wrap),
          turns,
        ),
        turns,
      ),
    )
  }
  if (launch) {
    return launch.over(
      withFeedback(
        withInbox(
          withConversations(launch.under(backend), launch.transcripts, turns, launch.wrap),
          turns,
        ),
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
        demoEntries(now),
      ),
      turns,
    )
  // The Inbox demo's agents elsewhere have done things before their items came, and one
  // has a lead, for the sheets to show (see `inbox/transcripts.ts`).
  const inbox = variant === "inbox"
  const seed = demoSeed(now, true)
  const conversing = withConversations(
    variant === "agents" || inbox
      ? withFinishes(
          withStorefrontArtifacts({ ...backend, seed: inbox ? withInboxLead(seed) : seed }),
          turns,
        )
      : backend,
    inbox ? { ...transcripts, ...inboxTranscripts(now) } : transcripts,
    turns,
  )
  // Only where the storefront's terminals run agents: the plain and welcome shells don't.
  if (variant === "plain" || variant === "welcome") return withInbox(conversing, turns)
  if (variant === "agents") return withSource(withPlanShows(withInbox(conversing, turns)), turns)
  return withSource(
    withPlanShows(
      withInbox(
        { ...conversing, messages: createDemoMessages([inboxLeadMessages(now)]) },
        turns,
        demoInboxRows(now),
      ),
    ),
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
