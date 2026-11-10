import type { ChatItem, Conversation, Conversations } from "@novadeck/core/conversation"
import type { PortableInstall } from "@novadeck/core/desktop/portable"
import type { SandboxState } from "@novadeck/core/desktop/sandbox"
import type { InboxRow, InboxSource } from "@novadeck/core/inbox"
import type { Approval, Approvals, Backend, Notice } from "@novadeck/core/port"
import { createStore, type Store } from "@novadeck/core/store"
import { createDemoBackend } from "@novadeck/demo"
import {
  createDemoPortable,
  type DemoPortable,
  type PortableSchedule,
} from "@novadeck/demo-debug/desktop/portable"
import { createDemoSandbox, sampleFix } from "@novadeck/demo-debug/desktop/sandbox"
import {
  portableScenarios,
  updateScenarios,
  type PortableScenarioKey,
  type UpdateScenario,
  type UpdateScenarioKey,
} from "@novadeck/demo-debug/desktop/scenarios"
import { createDemoUninstall, uninstallScenarios } from "@novadeck/demo-debug/desktop/uninstall"
import { createDemoUpdates } from "@novadeck/demo-debug/desktop/updates"
import { addressParams } from "@novadeck/demo/address"
import { demoTurns } from "@novadeck/demo/agents/turns"
import { isDemoInbox } from "@novadeck/demo/inbox"
import { demoInboxRowsAll } from "@novadeck/demo/inbox/fixtures"
import { createShowcaseDemo } from "@novadeck/demo/showcase/demo"
import { createDemo } from "@novadeck/demo/variants"
import { babciaCuesOf, type BabciaCues } from "@novadeck/demo/videos/babcia"
import { visitorDemo } from "@novadeck/demo/visitor/index"
import { pageTheme } from "@novadeck/ui/theme/source"

// The demo's variants a spec asks for in its address, and the backend that offers them:
// the one place specs and tests reach the demo, kept out of the file that chooses
// the backend so the demo stays one folder.

// Specs open the showcase demo, with its agents' plans and artifacts, by adding
// `?demo=showcase` to the address's hash. The address is read when the workspace mounts,
// since each spec sets its own.
const showcaseRequested = (): boolean => addressParams().get("demo") === "showcase"

// Specs open the demo as an app that has an update with `?update=` one of the debug
// panel's update scenarios (see @novadeck/demo-debug/desktop/scenarios), beside any other variant.
const requestedUpdate = (): UpdateScenario | undefined => {
  const key = addressParams().get("update")
  return key && Object.hasOwn(updateScenarios, key)
    ? updateScenarios[key as UpdateScenarioKey]
    : undefined
}

// Specs open the demo as an app that follows experimental builds, which turns IS_EXPERIMENTAL on
// (the chat view still needs its own switch), with `?channel=experimental`, beside any other variant
// and the showcase.
const experimentalRequested = (): boolean => addressParams().get("channel") === "experimental"

// The updates a spec asks for: an explicit `?update=` wins, else the release a portable
// scenario has waiting (as the debug panel offers it); `?channel=experimental` alone has an app
// with no update waiting.
const demoWithUpdate = (
  scenario: UpdateScenario | undefined,
  portable: DemoPortable | undefined,
  demo: ReturnType<typeof createDemoBackend>,
): ReturnType<typeof createDemoBackend> => {
  const experimental = experimentalRequested()
  if (!scenario && !portable?.offer && !experimental) return demo
  // A restart is counted, not done: it would reload the page the spec is looking at.
  const controls = createDemoUpdates(() => void (restarts += 1))
  if (experimental) controls.updates?.channel?.set("experimental")
  if (scenario) scenario.play(controls, "0.0.80")
  else if (portable?.offer) controls.offer(portable.offer)
  made.push(controls)
  return { ...demo, updates: controls.updates, whatsNew: controls.whatsNew }
}

// The updates of every backend made since the page opened: StrictMode makes two and keeps
// one, so what the spec does reaches each, and what the page asked of the app is counted
// across them.
const made: ReturnType<typeof createDemoUpdates>[] = []

// How many times the page has asked the app to restart into an update since it opened.
let restarts = 0
export const restartsAsked = (): number => restarts

/** Has the app's update download begin, in the backend the page uses (and its twin). */
export const startDownload = (version: string): void =>
  made.forEach((each) => each.download(version))

/** Has the app report this download progress, in the backend the page uses (and its twin). */
export const reportProgress = (version: string, percent: number): void =>
  made.forEach((each) => each.offer({ kind: "downloading", version, percent }))

/** How many times the page has asked the app what is new since the page opened. */
export const whatsNewAsked = (): number =>
  made.reduce((sum, each) => sum + each.whatsNewCalls.asked, 0)

/** What the page has asked of the app about what's new since the page opened. */
export const whatsNewCalls = (): { readonly dismissed: number } => ({
  dismissed: made.reduce((sum, each) => sum + each.whatsNewCalls.dismissed, 0),
})

// Specs open the demo as an app running without its security sandbox with `?sandbox=off`,
// or `?sandbox=off-unfixed` for one with no command to offer.
const requestedSandbox = (): SandboxState | undefined => {
  const sandbox = addressParams().get("sandbox")
  if (sandbox === "off") return { sandboxed: false, fix: sampleFix }
  if (sandbox === "off-unfixed") return { sandboxed: false, fix: "" }
  return undefined
}

// Specs open the demo on a portable copy with `?portable=` one of the debug panel's
// portable scenarios (see @novadeck/demo-debug/desktop/scenarios). Installing takes no time there,
// unless `&installMs=` says how long, or `&installMs=stepped` holds each step for the spec
// to take with `portableInstall.advanceTo`, as a slow machine would otherwise pass a step
// before the spec reads it.
const requestedPortable = (): DemoPortable | undefined => {
  const query = addressParams()
  const key = query.get("portable")
  if (!key || !Object.hasOwn(portableScenarios, key)) return undefined
  const portable = portableScenarios[key as PortableScenarioKey].setup("0.0.80")
  if (!portable) return undefined
  const installMs = query.get("installMs") === "stepped" ? 3000 : Number(query.get("installMs"))
  return { ...portable, installAfterMs: installMs > 0 ? installMs : 0 }
}

// The steps of a stepped install, in the order their waits would have run them.
const held: { readonly at: number; readonly next: PortableInstall; readonly apply: () => void }[] =
  []
const stepped = (): boolean => {
  const on = addressParams().get("installMs") === "stepped"
  // Each workspace a spec opens is a new backend, whose install starts with nothing held.
  if (on) held.length = 0
  return on
}
const hold: PortableSchedule = (apply, next, at) => void held.push({ at, next, apply })

/** A stepped install (`&installMs=stepped`), which moves only when the spec says. */
export const portableInstall = {
  /** Takes the held steps in order until one leaves the install in `phase`. */
  advanceTo: (phase: PortableInstall["phase"]): void => {
    held.sort((a, b) => a.at - b.at)
    for (let step = held.shift(); step; step = held.shift()) {
      step.apply()
      if (step.next.phase === phase) return
    }
    throw new Error(`No step of the install left that reaches ${phase}`)
  },
}

// Specs open the demo as an app that offers uninstalling with `?uninstall=` one of the
// debug panel's scenarios (see @novadeck/demo-debug/desktop/uninstall).
const requestedUninstall = (): Backend["uninstall"] => {
  const name = addressParams().get("uninstall")
  return name && Object.hasOwn(uninstallScenarios, name)
    ? createDemoUninstall(uninstallScenarios[name as keyof typeof uninstallScenarios]).uninstall
    : undefined
}

// `&version=dev` makes the app a development build, which carries 0.0.0, and
// `&version=none` one that gives no version and keeps no logs, as a browser.
const requestedVersion = (
  backend: ReturnType<typeof createDemoBackend>,
): ReturnType<typeof createDemoBackend> => {
  const version = addressParams().get("version")
  if (version === "dev") return { ...backend, version: () => Promise.resolve("0.0.0") }
  if (version !== "none") return backend
  const { version: _given, openLogs: _logs, ...rest } = backend
  return rest
}

// `&transcripts=unavailable` makes the app one that cannot keep transcripts encrypted.
const requestedTranscripts = (
  backend: ReturnType<typeof createDemoBackend>,
): ReturnType<typeof createDemoBackend> => {
  return addressParams().get("transcripts") === "unavailable" && backend.transcripts
    ? { ...backend, transcripts: { ...backend.transcripts, available: false } }
    : backend
}

// `&gap=on` makes every agent's record hold a part of the conversation the runner can't read,
// as one a harness release added inside a message: the runner gives the chat a gap there, which
// the demo's own transcripts never need.
const requestedGap = (
  backend: ReturnType<typeof createDemoBackend>,
): ReturnType<typeof createDemoBackend> => {
  const { conversations } = backend
  if (addressParams().get("gap") !== "on" || !conversations) return backend
  return { ...backend, conversations: gappedConversations(conversations) }
}

const gapItem: ChatItem = {
  id: "gap",
  at: null,
  role: "note",
  kind: "text",
  text: '{"type":"hologram"}',
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  outcome: null,
  scripted: false,
  interrupted: false,
  ring: null,
  note: { type: "gap" },
}

const gappedConversations = (conversations: Conversations): Conversations => ({
  ...conversations,
  conversation: (key) => {
    const store = conversations.conversation(key)
    // The same snapshot for the same conversation, as a store gives.
    let from: Conversation | undefined
    let shown: Conversation | undefined
    const snapshot = (): Conversation => {
      const next = store.getSnapshot()
      if (next !== from || !shown) {
        from = next
        shown = next.session === null ? next : { ...next, items: [...next.items, gapItem] }
      }
      return shown
    }
    const gapped: Store<Conversation> = { subscribe: store.subscribe, getSnapshot: snapshot }
    return gapped
  },
})

// Specs open the demo as a visitor's, with `?visitor=on`: what the app shows for one.
// `&turnMs=` and `&nudgeMs=` shorten its agents' turns and the wait before Codex asks;
// `&readingMs=` has Claude Code read that long before its plan comes, and none without. What
// goes on at the desk by itself stays out of specs.
const visitorRequested = (): boolean => addressParams().get("visitor") === "on"

const visitorTimings = (): {
  turnMs?: number
  nudgeMs?: number
  readingMs: number
  ambient: false
} => {
  const params = addressParams()
  const turnMs = timerMs(params.get("turnMs"))
  const nudgeMs = timerMs(params.get("nudgeMs"))
  return {
    ...(turnMs > 0 && { turnMs }),
    ...(nudgeMs > 0 && { nudgeMs }),
    readingMs: timerMs(params.get("readingMs")),
    ambient: false,
  }
}

// The longest wait a timer keeps: a longer one, Infinity among them, fires at once.
const longestTimerMs = 2_147_483_647

// A wait the address gives, in milliseconds, as a timer keeps it: 0 for none or nonsense.
const timerMs = (value: string | null): number => {
  const ms = Number(value)
  return ms > 0 ? Math.min(ms, longestTimerMs) : 0
}

// Specs open the Babcia demo with `?demo=babcia`, and ring its cues, as the debug panel does.
const babciaRequested = (): boolean => addressParams().get("demo") === "babcia"

// The cues of every Babcia demo made (StrictMode makes two and keeps one; a cue acts only in
// the one the page started).
const babciaCues: BabciaCues[] = []

/** The Babcia demo's seasonal-specials agent shows its page in the pane, with no click. */
export const agentShowsPage = (): void => babciaCues.forEach((cues) => cues.show())

// Specs open the demo as a desktop-like app with `&desktop=on`: one that reports whether its
// window has the system's focus, which the spec moves with `desktopWindow.focus`, and keeps the
// OS notifications it was asked to show, which the spec reads with `desktopWindow.notices`.
const desktopRequested = (): boolean => addressParams().get("desktop") === "on"

type DesktopWindow = {
  readonly inbox: ReturnType<typeof createDemoBackend>["inbox"]
  readonly focusListeners: Set<(focused: boolean) => void>
  readonly shown: Notice[]
}

// The desktop windows of every backend made since the page opened: StrictMode makes two
// and keeps one, so what the spec does reaches each, and what the page did is read from them all.
const desktops: DesktopWindow[] = []

const asDesktop = (
  demo: ReturnType<typeof createDemoBackend>,
): ReturnType<typeof createDemoBackend> => {
  const desktop: DesktopWindow = {
    inbox: demo.inbox,
    focusListeners: new Set(),
    shown: [],
  }
  desktops.push(desktop)
  return {
    ...demo,
    windowFocus: (listener) => {
      desktop.focusListeners.add(listener)
      listener(true)
      return () => void desktop.focusListeners.delete(listener)
    },
    notices: {
      show: (notice) => void desktop.shown.push(notice),
      onClick: () => () => undefined,
    },
  }
}

// The demo's Inbox rows (by fixture id) join every window's Inbox now, in the order given,
// waiting from now, as `change` makes them.
const arriving = (
  ids: readonly string[],
  change: (row: InboxRow) => InboxRow = (row) => row,
): void => {
  const now = Date.now()
  for (const each of desktops) {
    if (!isDemoInbox(each.inbox)) continue
    for (const id of ids) {
      const found = demoInboxRowsAll(now).find((row) => row.id === id)
      if (!found) throw new Error(`No Inbox fixture ${id}`)
      each.inbox.add(change({ ...found, at: now }))
    }
  }
}

/** The window of the desktop-like app of `&desktop=on`, and the Inbox behind it. */
export const desktopWindow = {
  /** The system gives the app's window its focus, or takes it away. */
  focus: (focused: boolean): void =>
    desktops.forEach((each) => each.focusListeners.forEach((listener) => listener(focused))),
  /** The OS notifications the page has shown, by title. */
  notices: (): string[] => desktops.flatMap((each) => each.shown.map((notice) => notice.title)),
  /** The demo's Inbox rows (by fixture id) join it now, in the order given, waiting from now. */
  arrive: (...ids: readonly string[]): void => arriving(ids),
  /** A demo Inbox row (by fixture id) joins it now as `agent`'s, for a harness the demo's own
   * rows don't come from. */
  arriveAs: (id: string, agent: InboxSource["agent"]): void =>
    arriving([id], (row) => ({ ...row, source: { ...row.source, agent } })),
  /** The ids of the rows the page's backend Inbox holds, whether or not it lists them (the
   * first window is the page's: StrictMode's second is dropped and never answered). */
  rowIds: (): string[] => desktops[0]?.inbox?.state.getSnapshot().items.map((row) => row.id) ?? [],
  /** The ids of the asks the page's backend Inbox holds settled (dismissed, withdrawn or replied). */
  settledIds: (): string[] =>
    desktops[0]?.inbox?.state
      .getSnapshot()
      .items.filter((row) => row.settled)
      .map((row) => row.id) ?? [],
  /** An ask is settled as withdrawn by its agent, and stays listed. */
  withdraw: (id: string): void =>
    desktops.forEach((each) =>
      isDemoInbox(each.inbox) ? each.inbox.resolve(id, "withdrawn") : undefined,
    ),
}

// Specs open the messages demo with a nested team with `&nested=on`: @moth (Checkout
// implementation) leads @owl (Tests) and Runtime, and @owl leads @crow (Checkout review, which
// needs permission) in turn, a team inside @moth's.
const nestedRequested = (): boolean => addressParams().get("nested") === "on"

const withNestedTeam = (
  backend: ReturnType<typeof createDemoBackend>,
): ReturnType<typeof createDemoBackend> => ({
  ...backend,
  seed: {
    ...backend.seed,
    projects: backend.seed.projects.map((project) => ({
      ...project,
      sessions: project.sessions.map((session) => ({
        ...session,
        terminals: session.terminals.map((terminal) =>
          terminal.handle === "owl" || terminal.name === "Runtime"
            ? { ...terminal, ledBy: "moth" }
            : terminal.handle === "crow"
              ? { ...terminal, ledBy: "owl" }
              : terminal,
        ),
      })),
    })),
  },
})

// The demo a spec opens, as its address's hash asks.
export const createSpecBackend = (): ReturnType<typeof createDemoBackend> => {
  const plain = plainSpecBackend()
  const demo = nestedRequested() ? withNestedTeam(plain) : plain
  const withApprovals = approvalsRequested() ? { ...demo, approvals: specApprovals() } : demo
  // Keeps no arrangement, as a demo doesn't, but takes the one a spec leaves in storage
  // (`novadeck.project-arrangement`) as an earlier client's, which the app imports.
  return {
    ...(desktopRequested() ? asDesktop(withApprovals) : withApprovals),
    arrange: async () => {},
  }
}

// Specs open the demo with a backend that has agents ask the person's approval with
// `&approvals=on`: the spec makes an agent ask with `approvals.ask`, and reads the person's
// answers with `approvals.answers`.
const approvalsRequested = (): boolean => addressParams().get("approvals") === "on"

type SpecApprovals = Approvals & {
  readonly pending: ReturnType<typeof createStore<readonly Approval[]>>
  readonly answered: { readonly requestId: string; readonly approved: boolean }[]
}

// The approvals of every backend made since the page opened: StrictMode makes two and keeps
// one, so an ask reaches each, and the page's answers are read from them all.
const approvalBackends: SpecApprovals[] = []

const specApprovals = (): Approvals => {
  const pending = createStore<readonly Approval[]>([])
  const answered: SpecApprovals["answered"] = []
  const asked: SpecApprovals = {
    pending,
    answered,
    answer: (requestId, approved) => {
      if (!pending.getSnapshot().some((each) => each.requestId === requestId)) return
      answered.push({ requestId, approved })
      pending.update((waiting) => waiting.filter((each) => each.requestId !== requestId))
    },
  }
  approvalBackends.push(asked)
  return asked
}

/** What agents ask the person to allow, in the app of `&approvals=on`. */
export const approvals = {
  /** An agent asks, queued behind the approvals already waiting. */
  ask: (approval: Approval): void =>
    approvalBackends.forEach((each) => each.pending.update((waiting) => [...waiting, approval])),
  /** The person's answers, in the order given. */
  answers: (): { readonly requestId: string; readonly approved: boolean }[] =>
    approvalBackends.flatMap((each) => each.answered),
}

// Specs open the demo as a backend that takes no feedback with `&feedback=off`, so the footer
// has no feedback button.
const withoutFeedback = (
  demo: ReturnType<typeof createDemoBackend>,
): ReturnType<typeof createDemoBackend> => {
  if (addressParams().get("feedback") !== "off") return demo
  const { feedback, ...rest } = demo
  void feedback
  return rest
}

const plainSpecBackend = (): ReturnType<typeof createDemoBackend> => {
  if (babciaRequested()) {
    const demo = createDemo("babcia", { theme: pageTheme }, demoTurns())
    const cues = babciaCuesOf(demo)
    if (cues) babciaCues.push(cues)
    return demo
  }
  if (visitorRequested()) return visitorDemo({ ...visitorTimings(), theme: pageTheme })
  // `?channel=experimental` too, for the chat view beside what the showcase's agents showed.
  if (showcaseRequested())
    return demoWithUpdate(undefined, undefined, createShowcaseDemo({ theme: pageTheme }))
  const update = requestedUpdate()
  const sandbox = requestedSandbox()
  const portable = requestedPortable()
  const demo = requestedGap(
    requestedTranscripts(
      requestedVersion(
        withoutFeedback(demoWithUpdate(update, portable, createDemoBackend({ theme: pageTheme }))),
      ),
    ),
  )
  const uninstall = requestedUninstall()
  const withSandbox = sandbox ? { ...demo, sandbox: createDemoSandbox(sandbox) } : demo
  const withUninstall = uninstall ? { ...withSandbox, uninstall } : withSandbox
  return portable
    ? {
        ...withUninstall,
        portable: createDemoPortable(portable, stepped() ? { schedule: hold } : {}).portable,
      }
    : withUninstall
}

/**
 * Forgets what earlier pages' backends left (their updates, desktop windows, approvals and Babcia
 * cues), as the workspace opens: what a spec reads and drives is then the page it has open,
 * though an earlier spec or an earlier page of its own made more.
 */
export const forgetEarlierPages = (): void => {
  approvalBackends.length = 0
  made.length = 0
  desktops.length = 0
  babciaCues.length = 0
}
