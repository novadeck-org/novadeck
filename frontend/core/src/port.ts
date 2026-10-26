import type { Conversations } from "./conversation"
import type { Feedback } from "./feedback"
import type { AgentName } from "./harnesses"
import type { Inbox } from "./inbox"
import type { Companions } from "./items"
import type { Messages } from "./messages"
import type { Murmur } from "./murmur"
import type { PortableState } from "./portable"
import type { SandboxState } from "./sandbox"
import type { WorkspaceSeed } from "./seed"
import type { Source } from "./source"
import type { WorkspaceAction } from "./state"
import type { Store } from "./store"
import type { TelemetryReader } from "./telemetry"
import type {
  TerminalKey,
  TerminalMetadata,
  TerminalStatus,
  ViewMode,
  Workspace,
  WorkspaceTarget,
} from "./types"
import type { UninstallPlan, UninstallResult } from "./uninstall"
import type { UpdateChannel, UpdateOffer, WhatsNew } from "./update"
import type { Voice } from "./voice"

// The UI-owned contract every terminal backend implements. Only app/ talks to it.

export type { TerminalKey }

// One terminal drawn into an element the UI gives it, synchronously: its input exists on
// return. The mount owns the element's children; the UI owns the element (its classes, its
// place) and moves it, never the children. A new key is a new mount.
//
// The UI draws the terminal's window and what lies over its output (the lock, the notice of a
// failed paste, the ending bar) around the element, from `TerminalMount.state`, and relies on
// this markup:
// - The UI's host puts `data-terminal-content` on its root (view transitions morph it),
//   `nodrag nopan` so Canvas does not drag or pan from the content, and a wheel stop without
//   Ctrl/Meta so scrolling output does not zoom the canvas while pinch and Ctrl+wheel still
//   do. The mount never needs to know.
// - The mount puts exactly one `data-terminal-input` inside its element, on the element that
//   takes typed input. Shortcuts treat it as terminal input, search returns focus to it,
//   overlays and dictation find the terminal by it.
// - Its own styles may key off the frame's `terminal-compact` (Grid and Canvas) and
//   `terminal-focused` (Focus) classes; ship them with the adapter.
export type MountTerminal = (
  element: HTMLElement,
  key: TerminalKey,
  props: TerminalMountProps,
) => TerminalMount

// Plain data; the UI passes a fresh object when a field changes.
export type TerminalMountProps = {
  // Names its input for assistive technology.
  readonly name: string
  // The terminal's status. An exited or failed one takes only Enter, to start again.
  readonly status: TerminalStatus["state"]
  // The view it shows in. A backend may draw differently in one, as the runner's keeps
  // Canvas's on the DOM renderer, since Canvas zooms with a transform that stretches a
  // GPU-drawn screen.
  readonly view: ViewMode
  // Whether the element is where the person can see it. A mount off screen may let its screen
  // go, and takes it again when it is back; the element keeps the last drawing. A mount
  // created off screen takes none until it is on screen. Absent means on screen.
  readonly onScreen?: boolean
}

export type TerminalMount = {
  // What the UI draws around the terminal: a stable snapshot until something changes, and
  // the same store for the mount's life, so `useSyncExternalStore` can hold it. Methods may
  // be called unbound.
  readonly state: Store<ViewState>
  // Equal values change nothing: no I/O, no notification, no DOM write.
  readonly update: (props: TerminalMountProps) => void
  // Focuses the input, and says whether the focus landed in the terminal. A mount that is
  // off screen, or whose screen is on its way, answers false; the UI asks again.
  readonly focus: () => boolean
  // A fresh shell in an exited or failed terminal.
  readonly restart: () => void
  // Called while the element is still in the document, so focus carries to the next mount.
  // Safe twice; leaves the element's content where it is.
  readonly dispose: () => void
}

// Why a terminal refuses input.
export type TerminalLock = "starting" | "loading" | "reconnecting" | "offline"
export type ViewState = {
  // A stream draws the current shell.
  readonly live: boolean
  // Taking up again after a reconnection.
  readonly resuming: boolean
  // The stream told of an exit before the status did.
  readonly waits: boolean
  // Why input is refused; null while it takes input.
  readonly lock: TerminalLock | null
  // Why the last paste failed, for a few seconds after it did.
  readonly notice: string | null
}
// The terminal font from Preferences, in CSS pixels.
export type TerminalFont = { readonly size: number }

// The page's theme, as a backend reads it for what it paints outside CSS, such as a
// terminal's colours: the tokens' values where `element` draws, and each time a theme is
// applied. The app's entry hands it over, so no backend reads the theme layer itself.
export type ThemeSource = {
  readonly tokens: (element: Element, names: readonly string[]) => Partial<Record<string, string>>
  readonly onChange: (listener: () => void) => () => void
}

// How a backend draws terminals: it mounts them into elements the UI gives it.
export type TerminalPort = {
  // Created once per backend instance so its identity is stable across renders.
  readonly mountTerminal: MountTerminal
  // The font size from Preferences, called once before the first mount and again when it
  // changes. Synchronous bookkeeping with no I/O.
  readonly setFont: (font: TerminalFont) => void
}

// Workspace changes a backend reports on its own, as the owner of every terminal, item
// and window: a terminal added elsewhere (another window, an agent), a name or directory
// changed, a process exiting, a program taking over the foreground, or a terminal
// closed, as by a shell that ended cleanly; something an agent showed or showed again,
// moved, or gone; a window undocked, renamed or closed elsewhere.
export type BackendAction = Extract<
  WorkspaceAction,
  {
    type:
      | "terminal/add"
      | "terminal/update"
      | "terminal/status"
      | "terminal/process"
      | "terminal/close"
      | "item/upsert"
      | "item/remove"
      | "window/upsert"
      | "window/remove"
  }
>

// An agent in terminal `from` asked for a new terminal beside it: in `directory`,
// running `command` at its first prompt; `focus` when the person asked to see it. The
// backend names it as the agent asked. The app answers once: the terminal it added, which the backend
// then starts with the request's command, or why it couldn't, in a sentence for the agent.
export type TerminalRequest = {
  readonly from: string
  readonly directory: string
  readonly command?: string
  readonly focus: boolean
  readonly answer: (result: { readonly terminalId: string } | { readonly reason: string }) => void
}

export type BackendSink = {
  // Commits the actions as one store transaction, like a UI command. Actions for a
  // project, session or terminal that no longer exists are no-ops, and calls after
  // stop are ignored. Never call it from inside `commit`; the store throws.
  readonly dispatch: (actions: readonly BackendAction[]) => void
  // Hands the app a request for a new terminal, which it adds where its "+" would. After
  // stop, the request is refused. Never call it from inside `commit`.
  readonly open: (request: TerminalRequest) => void
}

export type BackendFields = {
  // The workspace to start from, available before the app first renders. It needs at
  // least one project, each with at least one session; mounting throws otherwise.
  readonly seed: WorkspaceSeed
  // Allocates a terminal synchronously so commands can select and rename it at once. The
  // backend owns it, and names it: `title` where given, else its own default for the
  // session, which it may only know once the terminal is created, and then reports with
  // `terminal/update`. With `launch`, as for a request, its shell starts in `directory`
  // and runs `command` at its first prompt; otherwise it starts where the backend's new
  // terminals do.
  readonly newTerminal: (input: {
    target: WorkspaceTarget
    directory: string
    title?: string
    launch?: { readonly command?: string }
  }) => TerminalMetadata
  // Called inside every workspace store commit, before listeners, and once with []
  // for the initial workspace. That initial call runs during a render (a useState
  // initializer), possibly on an instance StrictMode then discards, so it must be
  // synchronous bookkeeping with no I/O. Later commits come from event handlers and
  // effects on the kept store; they stay synchronous but may start fire-and-forget
  // I/O, such as ending the process of a closed terminal that no view shows. Make
  // that I/O safe to repeat for the same terminal.
  readonly commit: (workspace: Workspace, actions: readonly WorkspaceAction[]) => void
  // What the agents in its terminals say of their tokens and quotas, by session and
  // terminal. Apart from the terminals' metadata, since an agent reports it often and a
  // report should reach only what reads the telemetry, not every subscriber of the roster.
  // A window reads its own terminal's `entry`, so a report wakes that window alone.
  readonly telemetry: TelemetryReader
  // Optional. Called from an effect after the app mounts, never on an instance
  // StrictMode discarded, with the sink for events the backend reports; returns stop.
  // StrictMode may start, stop and start the same instance again, so stop must undo
  // everything start began.
  readonly start?: (sink: BackendSink) => () => void
  // Optional. How the link to the far side is doing, for the footer. Updates may begin
  // only once `start` runs.
  readonly connection?: Store<BackendConnectionState>
  // Optional. Where the far side can keep crashing: the backend then stops restarting
  // terminals until the person asks it to try again.
  readonly crashLoop?: {
    // While the backend holds back, how many crashes it counted in the last minute;
    // 0 otherwise.
    readonly crashes: Store<number>
    // Starts over: the count clears and the terminals on screen that were lost or
    // failed start fresh shells.
    readonly retry: () => void
  }
  // Optional. How far the restored session is from ready, so the boot splash can stay
  // up until its terminals are attached. Absent means ready at once.
  readonly boot?: Store<BootProgress>
  // Optional. Whether each terminal's screen is kept on disk, to show again above its
  // fresh shell when it restores, and a way to change that. Absent where the backend
  // keeps none.
  readonly transcripts?: {
    readonly enabled: Store<boolean>
    // Whether the backend can keep them at all, fixed once it has loaded. They are saved
    // only encrypted, so where nothing can keep the key safe it keeps none, whatever
    // `enabled` says.
    readonly available: boolean
    readonly set: (enabled: boolean) => void
  }
  // Optional. The agents whose sessions resume after a restart once connected: each
  // connection installs a small plugin into the agent, and disconnecting removes it.
  // Absent where the backend cannot connect agents.
  readonly agents?: {
    readonly state: Store<readonly AgentConnection[]>
    // Connects or disconnects the agent; the state shows the change as it goes.
    readonly set: (agent: AgentName, connected: boolean) => void
    // Looks again at which agents are installed and connected.
    readonly refresh: () => void
    // Whether to offer connecting them when the app opens for the first time.
    readonly welcome: Store<boolean>
    readonly finishWelcome: () => void
  }
  // Optional. Where the content of what agents put in front of the person comes from: the
  // plans they write and what they show, which the backend reports as items through the
  // seed and `item/*` and `window/*` actions. Every terminal gets a taskbar and companion
  // pane. The runner reads them from the agents' files and what they present through
  // Novadeck's MCP server; the content-preview demo from its sample agents.
  readonly companions?: Companions
  // Optional. Messages between the agents in its terminals, and the pause that holds
  // them. A terminal with an agent bound, or one that has had messages, gets a messages
  // view in its companion pane, and its tab counts the messages waiting for its agent.
  // The pane needs `companions`: a backend with messages and nothing else to show passes
  // `emptyCompanions()`.
  readonly messages?: Messages
  // Optional. The conversations of the agents in its terminals, read from the agents' own
  // transcripts, and a way to prompt or stop them: a terminal running an agent gets a
  // chat view beside its screen. Absent where the backend reads no transcripts.
  readonly conversations?: Conversations
  // Optional. Voice input: the person speaks, and the backend transcribes it on its
  // machine. Absent where the backend cannot transcribe.
  readonly voice?: Voice
  // Optional. Murmur: a model on the backend's machine writes titles for its terminals.
  // Absent where the backend cannot run one.
  readonly murmur?: Murmur
  // Optional. The Inbox: what the agents in every project wait on the person for, one
  // item per agent terminal, answered in place, behind the bell. The runner's and the
  // demo's build it from the app's workspace (`bind`) and their own facts (see core's
  // `inbox-items`). Absent where the backend has none: the Inbox then lists nothing.
  readonly inbox?: Inbox
  // Optional. Each project's files, folder by folder, and on a demo backend what its agents
  // change in them, for the sidebar's Source panel (see core's `source`). Absent where the
  // backend can't read the projects' folders: the panel isn't drawn.
  readonly source?: Source
  // Optional. Feedback for the people building Novadeck (see core's `feedback`): the
  // footer's card, and an agent window's "Ask @handle to write feedback…". Absent where
  // the backend can't send it: neither is drawn. Today only the demo backend has it, and
  // it sends nothing anywhere.
  readonly feedback?: Feedback
  // Optional. Types text into a terminal as a paste, bracketed where its program asks,
  // without pressing Enter, as dictation does. Says whether it typed: false when the
  // terminal has gone or has no screen to take the text. Absent where terminals take no input.
  readonly typeInto?: (key: TerminalKey, text: string) => boolean
  // Optional. Hands a terminal's name back to the backend, which names it on its own
  // again: the name the person gave it goes, and the backend reports the one it takes
  // with `terminal/update`. Absent where names are only the person's.
  readonly resetTitle?: (key: TerminalKey) => void
  // Optional. Asks the person for a folder to open as a project; null when cancelled.
  // Absent where the backend cannot offer one.
  readonly pickDirectory?: () => Promise<string | null>
  // Optional. Tells the window around the page how the page looks, so its native parts
  // match; absent where nothing surrounds the page, as in a browser.
  readonly showAppearance?: (appearance: WindowAppearance) => void
  // Optional. Desktop notifications about terminals, as when an agent finishes while the
  // person looks elsewhere: `show` shows one, a newer one for the same terminal replacing
  // it, and `onClick` hears the terminal id of each the person clicks, once the window
  // around the page has come to the front; it returns the stop. Absent where nothing
  // surrounds the page, as in a browser. `close` takes away the one still showing for a
  // terminal, as when the person answered it in the app; nothing when none shows.
  readonly notices?: {
    readonly show: (notice: Notice) => void
    readonly close?: (terminalId: string) => void
    // Optional. Resolves true while the system holds notifications back (Do Not Disturb,
    // Focus), so the app's own sound stays silent; false when it does not or cannot tell.
    readonly quiet?: () => Promise<boolean>
    // Optional. True where the host's own notifications play Novadeck's sound (macOS), so
    // the app plays none of its own for them.
    readonly sounds?: boolean
    readonly onClick: (listener: (terminalId: string) => void) => () => void
  }
  // Optional. Shows how many items wait in the Inbox on the app's icon (the dock or
  // launcher badge; on Windows the taskbar overlay, drawn from `image`, a PNG data URL, or
  // none when null); a count of 0 clears it. Absent where nothing surrounds the page, as
  // in a browser.
  readonly badge?: (badge: { readonly count: number; readonly image: string | null }) => void
  // Optional. `listener` hears whether the app's window has the system's focus: at once
  // with the current state, and again on each change; returns the stop. Unlike the page's
  // own document, it stays focused while focus is inside a frame of the page, as a page
  // in the companion pane. Absent where nothing surrounds the page, as in a browser.
  readonly windowFocus?: (listener: (focused: boolean) => void) => () => void
  // Optional. The desktop app's self-updates: `onOffer` hears each update the app learns
  // of, at once when one already waits and again for each newer one, and returns the
  // stop. A `ready` offer is downloaded and installs when the app next quits. An
  // `available` one the app can't install itself, so the person gets it from its release
  // page, which `openPage` opens; one with `allow` can instead be let install itself by an
  // administrator, which `allow` asks for (macOS only; absent elsewhere). `channel`, where the app
  // lets the person choose, reads which releases it follows and switches them. Absent
  // where the app does not update itself, as in a browser.
  readonly updates?: {
    readonly onOffer: (listener: (offer: UpdateOffer) => void) => () => void
    readonly openPage: () => void
    readonly allow?: () => void
    readonly channel?: {
      readonly get: () => Promise<UpdateChannel>
      readonly set: (channel: UpdateChannel) => void
    }
  }
  // Optional. What is new in the version the desktop app updated to. `get` is asked once,
  // after the workspace is up, and answers the release's highlights while the person has
  // not dismissed them, else undefined (also when the notes can't be read, which the host
  // tries once more a couple of minutes later in the same launch, then on a later one); it
  // can take a couple of minutes. `dismiss` marks them seen,
  // so no later launch offers them again. Absent where
  // the app does not say, as in a browser.
  readonly whatsNew?: {
    readonly get: () => Promise<WhatsNew | undefined>
    readonly dismiss: () => void
  }
  // Optional. The version of the desktop app, asked once when Preferences needs it. Absent
  // in a browser and in a host that does not say.
  readonly version?: () => Promise<string>
  // Optional. Opens the folder of the desktop app's logs in the system's file manager, for
  // the person to read them or attach them to a bug report. Absent in a browser and in a host
  // that keeps none.
  readonly openLogs?: () => void
  // Optional. Whether the desktop app runs in Electron's security sandbox, asked once at
  // startup since the answer holds for the whole run. Absent in a browser and in a host
  // that does not say.
  readonly sandbox?: () => Promise<SandboxState>
  // Optional. Whether the desktop app is a portable copy, asked once at startup. A portable
  // never updates itself; `install` asks the host to put the app that does in place,
  // keeping the workspace, and answers nothing: the host owns how the install goes and
  // `onState` hears each step of it (`PortableState.install`), in every window, including
  // an install started from another window or before this page was reloaded. Once
  // `installed` (or `newer`) the installed copy takes effect when the person next opens
  // Novadeck. Nothing restarts by itself. Absent in a browser and in a host that has no
  // portable copy.
  readonly portable?: {
    readonly state: () => Promise<PortableState>
    readonly onState: (listener: (state: PortableState) => void) => () => void
    readonly install: () => void
  }
  // Optional. Removing the desktop app from this computer. `plan` says what that would do
  // here, asked each time Preferences opens; `run` removes the app, after the page has
  // disconnected the agents, and keeps the person's data folders when `keepData`; `quit`
  // ends the app once `run` said `removed`. Absent in a browser and in a host that has no
  // uninstall.
  readonly uninstall?: {
    readonly plan: () => Promise<UninstallPlan>
    readonly run: (options: { readonly keepData: boolean }) => Promise<UninstallResult>
    readonly quit: () => void
  }
  // Optional. Marks a public build for a website's visitors: the app shows it is a
  // simulation, with a call to download, and a narrow window gets a panel instead.
  readonly visitor?: true
  // Optional. Marks a demo backend: fixtures and simulated agents, as the try demo and the
  // previews have, never the runner. Features still being designed show only here: today the
  // sidebar's Source panel and feedback.
  readonly demo?: true
}

export type Backend = BackendFields & TerminalPort

// How the page looks, for the window around it: the scheme its native parts use
// (`system` while the page follows the system, so the page keeps seeing the system's
// own), and the ground, `--color-canvas` as `#rrggbb`, that the window shows before
// the page paints.
export type WindowAppearance = {
  readonly scheme: "system" | "light" | "dark"
  readonly ground: string
}

// A desktop notification about a terminal, by its id: a title and a body, one line each.
export type Notice = {
  readonly id: string
  readonly title: string
  readonly body: string
  // True when the notification should make no sound: the person turned Novadeck's sound off,
  // or it sounded just now for another. Only a host that plays the sound (`sounds`) heeds it.
  readonly silent?: boolean
}

// An agent the backend can connect, as the Preferences switches show it.
export type AgentConnection = {
  readonly agent: AgentName
  // Installed where the backend runs.
  readonly available: boolean
  readonly connected: boolean
  // A connect or disconnect is under way.
  readonly busy: boolean
  // Why the last change did not work, for the person.
  readonly error?: string
  // What keeps its messaging from working whole while connected, as the runner says.
  readonly limited?: "own-status-line" | undefined
}

// "unavailable" means the backend gave up reconnecting.
export type BackendConnectionState = "connected" | "reconnecting" | "unavailable"

// Must be free of side effects: StrictMode may call it twice.
export type CreateBackend = () => Backend

// A backend reached asynchronously, such as a runner the app must connect to first.
export type BackendConnection = {
  // Pure, like any CreateBackend: the seed is already loaded.
  readonly createBackend: CreateBackend
  // Ends the link once the app unmounts. Safe to call more than once.
  readonly close: () => void
}

// Connects before the app first renders. Rejects with an Error carrying a
// `failure: ConnectFailure`, which the boot splash explains and acts on. Aborting the
// signal abandons the attempt; a connection resolved after that is closed by the
// caller. It reports "loading" once the far side answered and the workspace is listed.
export type ConnectBackend = (
  signal: AbortSignal,
  progress: (stage: "loading") => void,
) => Promise<BackendConnection>

// Why connecting failed, sorted by what the person can do about it: a transient
// failure retries on its own, a different version or a workspace a newer Novadeck used can
// only quit, and the rest wait for Retry. `message` is for people; `code` and `detail` are for a bug report.
export type ConnectFailure = {
  readonly kind: "transient" | "incompatible" | "outdated" | "unauthorized" | "unknown"
  readonly message: string
  readonly code: string
  readonly detail: string
}

// The restored session's terminals being attached: `done` once they all are, have
// failed, or the backend stopped waiting.
export type BootProgress = {
  readonly attached: number
  readonly total: number
  readonly done: boolean
}

// What an app's entry chooses: a backend ready at once, or one to connect to.
export type BackendSelection =
  | { readonly createBackend: CreateBackend }
  | {
      readonly connect: ConnectBackend
      // Where the debug panel is offered: changes when it asks for a fresh boot, which
      // the app then runs from the splash without reloading the page.
      readonly reboots?: Store<number>
    }
