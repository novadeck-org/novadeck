import type { PortableInstall } from "@novadeck/core/desktop/portable"
import type { SandboxState } from "@novadeck/core/desktop/sandbox"
import type { InboxRow } from "@novadeck/core/inbox"
import type { Backend, Notice } from "@novadeck/core/port"
import { createDemoBackend } from "@novadeck/demo"
import {
  createDemoPortable,
  type DemoPortable,
  type PortableSchedule,
} from "@novadeck/demo-debug/portable"
import { createDemoSandbox, sampleFix } from "@novadeck/demo-debug/sandbox"
import {
  portableScenarios,
  updateScenarios,
  type PortableScenarioKey,
  type UpdateScenario,
  type UpdateScenarioKey,
} from "@novadeck/demo-debug/scenarios"
import { createDemoUninstall, uninstallScenarios } from "@novadeck/demo-debug/uninstall"
import { createDemoUpdates } from "@novadeck/demo-debug/updates"
import { babciaCuesOf, type BabciaCues } from "@novadeck/demo/babcia"
import { createContentDemo } from "@novadeck/demo/content"
import { isDemoInbox } from "@novadeck/demo/inbox"
import { demoInboxRowsAll } from "@novadeck/demo/inbox-fixtures"
import { demoTurns } from "@novadeck/demo/turns"
import { createDemo } from "@novadeck/demo/variants"
import { visitorDemo } from "@novadeck/demo/visitor/index"
import { pageTheme } from "@novadeck/ui/theme/source"

// The demo's variants a spec asks for in its address, and the backend that offers them:
// the one place specs and tests reach the demo, kept out of the file that chooses
// the backend so the demo stays one folder.

// The query after the address's hash, where a spec asks for a variant. The address is read
// when the workspace mounts, since each spec sets its own.
const asked = (): URLSearchParams => new URLSearchParams(window.location.hash.split("?")[1] ?? "")

// Specs open the content demo, with its agents' plans and artifacts, by adding
// `?demo=showcase` to the address's hash.
const showcaseRequested = (): boolean => asked().get("demo") === "showcase"

// Specs open the demo as an app that has an update with `?update=` one of the debug
// panel's update scenarios (see frontend/demo-debug/src/scenarios.ts), beside any other variant.
const requestedUpdate = (): UpdateScenario | undefined => {
  const key = asked().get("update")
  return key && Object.hasOwn(updateScenarios, key)
    ? updateScenarios[key as UpdateScenarioKey]
    : undefined
}

// Specs open the demo as an app that follows experimental builds, which turns IS_EXPERIMENTAL on
// (the chat view still needs its own switch), with `?channel=experimental`, beside any other variant.
const experimentalRequested = (): boolean => asked().get("channel") === "experimental"

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
  const controls = createDemoUpdates()
  if (experimental) controls.updates?.channel?.set("experimental")
  if (scenario) scenario.play(controls, "0.0.80")
  else if (portable?.offer) controls.offer(portable.offer)
  made.push(controls)
  return { ...demo, updates: controls.updates, whatsNew: controls.whatsNew }
}

// The updates of every backend made since `forgetUpdates`: StrictMode makes two and keeps
// one, so what the spec does reaches each, and what the page asked of the app is counted
// across them.
const made: ReturnType<typeof createDemoUpdates>[] = []

/** Forgets the updates of earlier pages' backends, so what the page asks of the app about
 * what's new is counted from nothing. */
export const forgetUpdates = (): void => void (made.length = 0)

/** Has the app's update download begin, in the backend the page uses (and its twin). */
export const startDownload = (version: string): void =>
  made.forEach((each) => each.download(version))

/** Has the app report this download progress, in the backend the page uses (and its twin). */
export const reportProgress = (version: string, percent: number): void =>
  made.forEach((each) => each.offer({ kind: "downloading", version, percent }))

/** How many times the page has asked the app what is new, since `forgetUpdates`. */
export const whatsNewAsked = (): number =>
  made.reduce((sum, each) => sum + each.whatsNewCalls.asked, 0)

/** What the page has asked of the app about what's new, since `forgetUpdates`. */
export const whatsNewCalls = (): { readonly dismissed: number } => ({
  dismissed: made.reduce((sum, each) => sum + each.whatsNewCalls.dismissed, 0),
})

// Specs open the demo as an app running without its security sandbox with `?sandbox=off`,
// or `?sandbox=off-unfixed` for one with no command to offer.
const requestedSandbox = (): SandboxState | undefined => {
  const sandbox = asked().get("sandbox")
  if (sandbox === "off") return { sandboxed: false, fix: sampleFix }
  if (sandbox === "off-unfixed") return { sandboxed: false, fix: "" }
  return undefined
}

// Specs open the demo on a portable copy with `?portable=` one of the debug panel's
// portable scenarios (see frontend/demo-debug/src/scenarios.ts). Installing takes no time there,
// unless `&installMs=` says how long, or `&installMs=stepped` holds each step for the spec
// to take with `portableInstall.advanceTo`, as a slow machine would otherwise pass a step
// before the spec reads it.
const requestedPortable = (): DemoPortable | undefined => {
  const query = asked()
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
  const on = asked().get("installMs") === "stepped"
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
// debug panel's scenarios (see frontend/demo-debug/src/uninstall.ts).
const requestedUninstall = (): Backend["uninstall"] => {
  const name = asked().get("uninstall")
  return name && name in uninstallScenarios
    ? createDemoUninstall(uninstallScenarios[name as keyof typeof uninstallScenarios]).uninstall
    : undefined
}

// `&version=dev` makes the app a development build, which carries 0.0.0, and
// `&version=none` one that gives no version and keeps no logs, as a browser.
const requestedVersion = (
  backend: ReturnType<typeof createDemoBackend>,
): ReturnType<typeof createDemoBackend> => {
  const version = asked().get("version")
  if (version === "dev") return { ...backend, version: () => Promise.resolve("0.0.0") }
  if (version !== "none") return backend
  const { version: _given, openLogs: _logs, ...rest } = backend
  return rest
}

// `&transcripts=unavailable` makes the app one that cannot keep transcripts encrypted.
const requestedTranscripts = (
  backend: ReturnType<typeof createDemoBackend>,
): ReturnType<typeof createDemoBackend> => {
  return asked().get("transcripts") === "unavailable" && backend.transcripts
    ? { ...backend, transcripts: { ...backend.transcripts, available: false } }
    : backend
}

// Specs open the demo as a visitor's, with `?visitor=on`: what the app shows for one.
// `&turnMs=` and `&nudgeMs=` shorten its agents' turns and the wait before Codex asks;
// `&readingMs=` has Claude Code read that long before its plan comes, and none without. What
// goes on at the desk by itself stays out of specs.
const visitorRequested = (): boolean => asked().get("visitor") === "on"

const visitorTimings = (): {
  turnMs?: number
  nudgeMs?: number
  readingMs: number
  ambient: false
} => {
  const params = asked()
  const turnMs = Number(params.get("turnMs"))
  const nudgeMs = Number(params.get("nudgeMs"))
  const readingMs = Number(params.get("readingMs"))
  return {
    ...(turnMs > 0 && { turnMs }),
    ...(nudgeMs > 0 && { nudgeMs }),
    readingMs: readingMs > 0 ? readingMs : 0,
    ambient: false,
  }
}

// Specs open the Babcia demo with `?demo=babcia`, and ring its cues, as the debug panel does.
const babciaRequested = (): boolean => asked().get("demo") === "babcia"

// The cues of every Babcia demo made (StrictMode makes two and keeps one; a cue acts only in
// the one the page started).
const babciaCues: BabciaCues[] = []

/** Forgets the cues of earlier pages' demos, as a spec opens its own. */
export const forgetBabciaCues = (): void => void (babciaCues.length = 0)

/** The Babcia demo's seasonal-specials agent shows its page in the pane, with no click. */
export const agentShowsPage = (): void => babciaCues.forEach((cues) => cues.show())

// Specs open the demo as a desktop-like app with `&desktop=on`: one that reports whether its
// window has the system's focus, which the spec moves with `desktopWindow.focus`, and keeps the
// OS notifications it was asked to show, which the spec reads with `desktopWindow.notices`.
const desktopRequested = (): boolean => asked().get("desktop") === "on"

type DesktopWindow = {
  readonly inbox: ReturnType<typeof createDemoBackend>["inbox"]
  readonly focusListeners: Set<(focused: boolean) => void>
  readonly shown: Notice[]
}

// The desktop windows of every backend made since `forgetDesktopWindow`: StrictMode makes two
// and keeps one, so what the spec does reaches each, and what the page did is read from them all.
const desktops: DesktopWindow[] = []

/** Forgets the windows of earlier pages' backends, as a spec opens its own. */
export const forgetDesktopWindow = (): void => void (desktops.length = 0)

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

/** The window of the desktop-like app of `&desktop=on`, and the Inbox behind it. */
export const desktopWindow = {
  /** The system gives the app's window its focus, or takes it away. */
  focus: (focused: boolean): void =>
    desktops.forEach((each) => each.focusListeners.forEach((listener) => listener(focused))),
  /** The OS notifications the page has shown, by title. */
  notices: (): string[] => desktops.flatMap((each) => each.shown.map((notice) => notice.title)),
  /** The demo's Inbox rows (by fixture id) join it now, in the order given, waiting from now. */
  arrive: (...ids: readonly string[]): void => {
    const now = Date.now()
    for (const each of desktops) {
      if (!isDemoInbox(each.inbox)) continue
      for (const id of ids) {
        const found = demoInboxRowsAll(now).find((row) => row.id === id)
        if (!found) throw new Error(`No Inbox fixture ${id}`)
        each.inbox.add({ ...found, at: now } satisfies InboxRow)
      }
    }
  },
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

// The demo a spec opens, as its address's hash asks.
export const createSpecBackend = (): ReturnType<typeof createDemoBackend> => {
  const demo = plainSpecBackend()
  // Keeps no arrangement, as a demo doesn't, but takes the one a spec leaves in storage
  // (`novadeck.project-arrangement`) as an earlier client's, which the app imports.
  return { ...(desktopRequested() ? asDesktop(demo) : demo), arrange: async () => {} }
}

const plainSpecBackend = (): ReturnType<typeof createDemoBackend> => {
  if (babciaRequested()) {
    const demo = createDemo("babcia", { theme: pageTheme }, demoTurns())
    const cues = babciaCuesOf(demo)
    if (cues) babciaCues.push(cues)
    return demo
  }
  if (visitorRequested()) return visitorDemo({ ...visitorTimings(), theme: pageTheme })
  if (showcaseRequested()) return createContentDemo({ theme: pageTheme })
  const update = requestedUpdate()
  const sandbox = requestedSandbox()
  const portable = requestedPortable()
  const demo = requestedTranscripts(
    requestedVersion(demoWithUpdate(update, portable, createDemoBackend({ theme: pageTheme }))),
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
