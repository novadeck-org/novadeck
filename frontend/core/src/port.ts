import type { Murmur } from "./addons/murmur"
import type { Voice } from "./addons/voice"
import type { TelemetryReader } from "./agents/telemetry"
import type { Conversations } from "./conversation"
import type { PortableState } from "./desktop/portable"
import type { ProjectWindows } from "./desktop/project-windows"
import type { SandboxState } from "./desktop/sandbox"
import type { UninstallPlan, UninstallResult } from "./desktop/uninstall"
import type { UpdateChannel, UpdateOffer, WhatsNew } from "./desktop/update"
import type { Feedback } from "./feedback"
import type { ProjectFiles } from "./files"
import type { Forges } from "./forges"
import type { AgentName } from "./harnesses"
import type { History } from "./history"
import type { Inbox } from "./inbox"
import type { Companions } from "./items"
import type { Messages } from "./messages"
import type { ProjectSeed, WorkspaceSeed } from "./seed"
import type { NoticeSound } from "./sounds"
import type { WorkspaceAction } from "./state"
import type { Store } from "./store"
import type {
  TerminalKey,
  TerminalMetadata,
  TerminalStatus,
  ViewMode,
  Workspace,
  WorkspaceTarget,
} from "./types"
import type { Works } from "./works"

// The UI-owned contract every terminal backend implements. Only app/ talks to it.

export type { TerminalKey }

// One terminal drawn into an element the UI gives it, synchronously: its input exists on
// return. The mount owns the element's children; the UI owns the element (its classes, its
// place) and moves it, never the children. A new key is a new mount.
//
// The UI draws the terminal's window and what lies over its output (the lock, the notice of
// a failed paste, the ending bar) around the element, from `TerminalMount.state`, and
// relies on this markup:
// - The UI's container for the element (`MountedTerminal`) puts `data-terminal-content` on
//   its root (view transitions morph it), `nodrag nopan` so Canvas does not drag or pan
//   from the content, and a wheel stop without Ctrl/Meta so scrolling output does not zoom
//   the canvas while pinch and Ctrl+wheel still do. The mount never needs to know.
// - The mount puts exactly one `data-terminal-input` inside its element, on the element
//   that takes typed input. Shortcuts treat it as terminal input, search returns focus to
//   it, overlays and dictation find the terminal by it.
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
  // Whether the person is looking at it: really in sight and legible, in the view that shows
  // it, for every terminal. A backend whose terminals can sleep wakes a sleeper it is told is
  // seen for a moment, and one with a runner tells it which are seen, so it moves nothing
  // there; any other ignores it. Absent means not seen.
  readonly seen?: boolean
  // Whether it is the selected terminal. Absent means selected.
  readonly selected?: boolean
  // Whether the person can see its screen where it is: false behind its chat, or kept out of
  // sight by its view, as Focus keeps the terminals it showed last. Absent means they can. A
  // backend may draw the output of one not seen, or not selected, in batches, as the runner's
  // does where drawing costs.
  readonly visible?: boolean
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
  // A short word for the person: why the last paste failed, for a few seconds after it
  // did, or that a copy reached the clipboard, for a moment.
  readonly notice: string | null
}
// The terminal font from Preferences: the size in CSS pixels, and the family the person chose,
// which goes in front of the theme's own chain; none is the theme's font.
export type TerminalFont = { readonly size: number; readonly family?: string }

// The page's theme, as a backend reads it for what it paints outside CSS, such as a
// terminal's colours: the tokens' values where `element` draws, and each time a theme is
// applied. The app's entry hands it over, so no backend reads the theme layer itself.
export type ThemeSource = {
  readonly tokens: (element: Element, names: readonly string[]) => Partial<Record<string, string>>
  readonly onChange: (listener: () => void) => () => void
  // The hue (1 to 8) the page draws an agent's handle in, as the Messages pane does, for what a
  // terminal draws of its agents' messages; handles read alike without it.
  readonly hueOf?: (handle: string) => number
}

// How a backend draws terminals: it mounts them into elements the UI gives it.
export type TerminalPort = {
  // Created once per backend instance so its identity is stable across renders.
  readonly mountTerminal: MountTerminal
  // The font from Preferences, called once before the first mount and again when it
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
      | "terminal/move"
      | "item/upsert"
      | "item/remove"
      | "window/upsert"
      | "window/remove"
      // Another client's change to a session they share.
      | "session/shared"
  }
>

// An agent in terminal `from` asked for a new terminal beside it: in `directory`, running
// `command` at its first prompt; `focus` when the person asked to see it. The backend names
// it as the agent asked. The app answers once: the terminal it added, which the backend
// then starts with the request's command, or why it couldn't, in a sentence for the agent.
export type TerminalRequest = {
  readonly from: string
  readonly directory: string
  readonly command?: string
  readonly focus: boolean
  readonly answer: (result: { readonly terminalId: string } | { readonly reason: string }) => void
}

// What an agent asks the person to allow: closing a terminal that runs an agent it doesn't
// lead or a program other than its shell, which ends it; leading a terminal that runs an
// agent, with a brief, so it then directs that agent and may close it; or running a command
// in a new terminal, `command` exactly as the shell would be given it, in `cwd`. A run's
// `terminalId` is the asking terminal's own; or taking the git worktree at `path`, on
// `branch`, from the terminal that owns it (`terminalId`); or joining the team of the terminal
// `terminalId`, with an introduction if it has one; leaving the team of the lead `terminalId`;
// or handing its own team to the terminal `terminalId`, which it leads.
export type ApprovalAction =
  | { readonly type: "close" }
  | { readonly type: "run"; readonly command: string; readonly cwd: string }
  | { readonly type: "lead"; readonly brief: string }
  | { readonly type: "take"; readonly path: string; readonly branch: string }
  | { readonly type: "join"; readonly message?: string | undefined }
  | { readonly type: "leave" }
  | { readonly type: "hand" }
  // An action a newer Novadeck's runner asks about that this one doesn't know: the person is
  // told it needs a newer Novadeck to answer, and nothing is answered from here.
  | { readonly type: "newer" }

// An agent in terminal `from` asked for `action` on `terminalId`, so the app asks the person
// first. It waits, with no time limit, until the person answers or the backend takes it
// back, as when either terminal closed meanwhile.
export type Approval = {
  readonly requestId: string
  readonly from: string
  readonly terminalId: string
  readonly action: ApprovalAction
}

export type Approvals = {
  // The approvals waiting on the person, oldest first.
  readonly pending: Store<readonly Approval[]>
  // Answers one: `approved` when the person allowed it, false when they declined. The
  // backend then acts, or not; one it no longer waits for is ignored.
  readonly answer: (requestId: string, approved: boolean) => void
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

// What a terminal's move did: the session it is in now, and each terminal it moved, the one
// asked for first and then its team, with its handle there and the one it had; `left` is
// the lead's handle it went without, null when it had none.
export type TerminalMoveResult = {
  readonly sessionId: string
  readonly moved: readonly {
    readonly terminalId: string
    readonly handle: string
    readonly was: string
  }[]
  // The id of the lead the terminal left, if it left one.
  readonly left: string | null
}

// What takes a move back: each moved terminal's handle before, by id, and the id of the lead
// it left.
export type TerminalMoveUndo = {
  readonly handles: Readonly<Record<string, string>>
  readonly lead?: string | undefined
}

// A run of the tour, readied (`Tour.prepare`): the folder it runs in, the command that starts
// its agent there, and where the agent's first line goes: on that command (`launch`), or rung
// once the agent shows in its terminal, which the UI asks for with `Tour.brief` (`doorbell`).
// `model` is the one the agent starts on, where one was picked. `removed` are the projects that
// were open at the folder, which the backend removed, terminals and all, before emptying it.
// `page` is whether the lead will run the game's dev server and show its page.
export type TourRun = {
  readonly directory: string
  readonly command: string
  readonly brief: "launch" | "doorbell"
  readonly model?: string | undefined
  readonly removed: readonly string[]
  readonly page: boolean
}

// Why a run of the tour can't start where the agent has to start first, as Codex does before
// it has listed its models: the sentence to show, and the agent to start.
export class TourNeedsAgent extends Error {
  constructor(
    message: string,
    readonly agent: AgentName,
  ) {
    super(message)
    this.name = "TourNeedsAgent"
  }
}

export type Tour = {
  // Readies a run with the agent; rejects, with a sentence to show, where it can't start:
  // with a `TourNeedsAgent` where the agent has to start first.
  readonly prepare: (agent: AgentName) => Promise<TourRun>
  // Rings the tour's start line to the agent in the terminal, once it shows there.
  readonly brief: (terminalId: string) => Promise<void>
  // Optional. Rings the tour's agent in the terminal a nudge to carry on with its brief, as
  // Novadeck's notice, where it has gone quiet; for the tour's own terminals only.
  readonly nudge?: (terminalId: string) => Promise<void>
  // Optional. Rings the artist's brief to the agent in the terminal the UI opened in the tour's
  // project, an agent on no team, once it shows there. A backend without it has no artist.
  readonly artist?: (terminalId: string) => Promise<void>
  // Optional. The person keeps the tour's project: it stops being the tour's, so nothing of the
  // tour's rules applies to it and no later run touches it, and the lead is told.
  readonly keep?: () => Promise<void>
  // Optional. How long the tour waits on its agent at a step before nudging it, in ms; the UI's
  // own wait when absent. The demo shortens it for specs.
  readonly patienceMs?: number
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
    // The History row (`history`) to restore as this terminal, in the row's own directory:
    // it takes the row's title and handle, and the row goes once the restore is confirmed.
    // `directory` is the row's, for the terminal to show until the backend says more; it
    // goes with no `title` or `launch`.
    closed?: string
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
  // Optional. How long an idle agent runs before the backend stops it: its session rests,
  // and the next message to it, or a look at it, starts it again where it left off. Absent
  // where the backend stops none.
  readonly hibernation?: {
    // The idle minutes before an agent is stopped; null for never.
    readonly after: Store<number | null>
    readonly set: (minutes: number | null) => void
  }
  // Optional. Whether Solo and Swarm may be picked, an Experimental switch the runner keeps:
  // while off, agents work as a Herd whatever the pick. Absent where the backend has none.
  readonly agentModes?: {
    readonly enabled: Store<boolean>
    readonly set: (enabled: boolean) => void
  }
  // Optional. Whether the shipping gate is on, an Experimental switch the runner keeps: while
  // on, Claude Code's and Codex's commands that ship work need a permit. Absent where the
  // backend has none.
  readonly shippingGate?: {
    readonly enabled: Store<boolean>
    readonly set: (enabled: boolean) => void
  }
  // Optional. How agents work with each other, which decides the version of Novadeck's tool
  // texts they get: Herd settles things between agents whose work meets, Solo keeps each to its
  // own work. Absent where the backend has no such setting.
  readonly agentMode?: {
    readonly mode: Store<AgentMode>
    readonly set: (mode: AgentMode) => void
  }
  // Optional. Whether agents may open git worktrees through Novadeck's tools, an Experimental
  // feature kept by the runner. Absent where the backend has none.
  readonly worktrees?: {
    readonly enabled: Store<boolean>
    readonly set: (enabled: boolean) => void
  }
  // Optional. The forges whose pull requests the Worktrees panel shows on works, an
  // Experimental feature kept by the runner. Absent where the backend has none.
  readonly forges?: Forges
  // Optional. The agents whose sessions resume after a restart once connected: each
  // connection installs a small plugin into the agent, and disconnecting removes it.
  // Absent where the backend cannot connect agents.
  readonly agents?: {
    readonly state: Store<readonly AgentConnection[]>
    // Connects or disconnects the agent; the state shows the change as it goes.
    readonly set: (agent: AgentName, connected: boolean) => void
    // Looks again at which agents are installed and connected; resolves once the state
    // shows what it found (also where it found nothing new, or could not look). With `fresh`
    // the backend reads the person's login environment again first, which spawns a shell:
    // for the look after an install, so a program just installed shows.
    readonly refresh: (options?: { readonly fresh?: boolean }) => Promise<void>
    // Whether to offer connecting them when the app opens for the first time.
    readonly welcome: Store<boolean>
    readonly finishWelcome: () => void
  }
  // Optional. Novadeck's tour: a live run of the person's own agent, on its cheapest model, in
  // a folder of the backend's own, which the UI opens as a project of its own. Absent where the
  // backend has none.
  readonly tour?: Tour
  // Optional. Where the content of what agents put in front of the person comes from: the
  // plans they write and what they show, which the backend reports as items through the
  // seed and `item/*` and `window/*` actions. Every terminal gets a companion bar and
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
  // row per agent terminal, answered in place, behind the bell. The runner's and the
  // demo's build it from the app's workspace (`bind`) and their own facts (see core's
  // `inbox/entries`). Absent where the backend has none: the Inbox then lists nothing.
  readonly inbox?: Inbox
  // Optional. Keeps how the person arranged the switcher: the projects' ids in their order,
  // and the pinned ones. The seed carries it back at the next load (`ProjectSeed.pinned`,
  // and the seed's order); no other client hears of it meanwhile. Resolves once kept, and
  // rejects if it couldn't be. Absent where the backend keeps none: the arrangement then
  // lasts the session.
  readonly arrange?: (arrangement: {
    readonly order: readonly string[]
    readonly pinned: readonly string[]
  }) => Promise<void>
  // Optional. What agents ask the person to allow (closing a terminal they don't lead,
  // leading a terminal), for the app to confirm. Absent where agents can't ask.
  readonly approvals?: Approvals
  // Optional. The person ends a terminal's lead: the terminal stays, its agent no longer
  // answers to the one that led it, and the backend reports `ledBy: null`. Absent where
  // agents can't lead.
  readonly releaseLead?: (key: TerminalKey) => void
  // Optional. The person moves a terminal to another session of its project, still running:
  // a lead with its whole team, a teammate on its own out of its lead's team. The backend
  // reports each move with `terminal/move`, and resolves with what it did, or rejects with
  // why it couldn't. `undo` takes an earlier move back: the handles they had and the lead
  // it left. Absent where terminals stay in their session.
  readonly moveTerminal?: (
    key: TerminalKey,
    sessionId: string,
    undo?: TerminalMoveUndo,
  ) => Promise<TerminalMoveResult>
  // Optional. Each project's files, folder by folder, and on a demo backend what its agents
  // change in them, for the sidebar's Files panel (see core's `files`). Absent where the
  // backend can't read the projects' folders: the panel isn't drawn.
  readonly files?: ProjectFiles
  // Optional. The terminals closed in the last 7 days, per project, to list and restore
  // (see core's `history`). Absent where the backend keeps none: closing is then final.
  readonly history?: History
  // Optional. Each terminal's work that differs from its repository's main branch, for the
  // sidebar's Worktrees panel (see core's `works`). Absent where the backend can't read the
  // terminals' checkouts: the panel isn't drawn.
  readonly works?: Works
  // Optional. Feedback for the people building Novadeck (see core's `feedback`): the
  // footer's card, and an agent window's "Ask @handle to write feedback…". Absent where
  // the backend can't send it: neither is drawn. The desktop app has it where it sends notes,
  // and the demo has one that sends nothing anywhere.
  readonly feedback?: Feedback
  // Optional. Types text into a terminal as a paste, bracketed where its program asks,
  // without pressing Enter, as dictation does. Says whether it typed: false when the
  // terminal has gone or has no screen to take the text. Absent where terminals take no input.
  readonly typeInto?: (key: TerminalKey, text: string) => boolean
  // Optional. Hands a terminal's name back to the backend, which names it on its own
  // again: the name the person gave it goes, and the backend reports the one it takes
  // with `terminal/update`. Absent where names are only the person's.
  readonly resetTitle?: (key: TerminalKey) => void
  // Optional. Asks which terminals hold work a restart would end: a program in a plain shell, a
  // line not finished, a job in the background or suspended; for an agent, whose own process
  // resumes, only work beside or under it (a Codex background terminal, a job of its shell's), by
  // terminal id, across every session. Read from the system when asked, so ask when it is
  // needed: while someone looks at the answer, and as they act on it. `unknown` are those it couldn't read, never to be taken for
  // idle. Answers nothing (undefined) where it can't tell at all, as from a runner that came
  // before it. Absent where the backend has no shells to look at.
  // With `fresh`, the answer comes from a read that starts after the call, as one about to act
  // on it needs; without, a read already under way may answer.
  readonly busyTerminals?: (options?: {
    readonly fresh?: true
  }) => Promise<
    { readonly busy: readonly string[]; readonly unknown: readonly string[] } | undefined
  >
  // Optional. Tells the backend which terminal the person is using in this window (its id),
  // or none (null): the one they look at while the window has their focus. A backend that runs
  // the terminals' programs gives it the CPU share of the app's own, and the others' programs
  // yield it. Told again, with no change, only where the link to the runner came back. Absent
  // where terminals run no programs on this machine, as in the demo.
  readonly activeTerminal?: (terminalId: string | null) => void
  // Optional. Tells the backend which project this window shows (null for none), so what an
  // agent asks of the person reaches the window that shows the project of the terminal that
  // asked. Told again, with no change, only where the link to the runner came back. Called only
  // while project windows are on. Absent where terminals run no programs, as in the demo.
  // `others` says another window exists, which may take over the project this one leaves: its
  // screens are let go of at once then, else kept for when this window shows it again.
  readonly showingProject?: (projectId: string | null, others?: boolean) => void
  // Optional. Reads a project from the runner again: its sessions, terminals and layouts as
  // the runner holds them now, for a window that takes the project on from another window, or
  // shows one it never heard of. What another window changes in a session this one holds
  // arrives live anyway (sessions/sharing.ts in the runner adapter).
  // Undefined for a project the runner no longer has. The page puts it in place with
  // `project/sync`, which adds a project it didn't know.
  readonly syncProject?: (projectId: string) => Promise<ProjectSeed | undefined>
  // Optional. Asks the person for a folder to open as a project; null when cancelled.
  // Absent where the backend cannot offer one.
  readonly pickDirectory?: () => Promise<string | null>
  // Optional. Tells the window around the page how the page looks, so its native parts
  // match; absent where nothing surrounds the page, as in a browser.
  readonly showAppearance?: (appearance: WindowAppearance) => void
  // Optional. Scales the app's windows, by a fraction of their normal size; absent where
  // nothing surrounds the page, as in a browser, whose own zoom does it.
  readonly showScale?: (scale: number) => void
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
    // Optional. True where the desktop app's own notifications play Novadeck's sound (macOS), so
    // the app plays none of its own for them.
    readonly sounds?: boolean
    readonly onClick: (listener: (terminalId: string) => void) => () => void
  }
  // Optional. Shows how many rows wait in the Inbox on the app's icon (the dock or
  // launcher badge; on Windows the taskbar overlay, drawn from `image`, a PNG data URL, or
  // none when null); a count of 0 clears it. Absent where nothing surrounds the page, as
  // in a browser.
  readonly badge?: (badge: { readonly count: number; readonly image: string | null }) => void
  // Optional. `listener` hears whether the app's window has the system's focus: at once
  // with the current state, and again on each change; returns the stop. Unlike the page's
  // own document, it stays focused while focus is inside a frame of the page, as a page
  // in the companion pane. Absent where nothing surrounds the page, as in a browser.
  readonly windowFocus?: (listener: (focused: boolean) => void) => () => void
  // Optional. The desktop app's project windows: this page is one window of several, each
  // showing one project. Absent where nothing can open another window, as in a browser, the
  // demo and the try page.
  readonly projectWindows?: ProjectWindows
  // Optional. The window's own controls where they sit over the page's top, its header standing
  // in for a title bar, at its `side`: macOS's close, minimise and zoom buttons at the start,
  // Windows' caption buttons at the end, which run from the page's top and can't hide: `place`
  // centres them on a line `middle` CSS pixels below the page's top, or hides them (null);
  // `onInset`'s listener hears the room they take from the page's edge on `side`, in CSS pixels,
  // in answer to each `place` and again on each change, 0 while they don't show (full screen,
  // or hidden); it returns the stop. Absent where the window has a title bar of its own
  // above the page, or nothing surrounds the page, as in a browser.
  readonly windowControls?: {
    readonly side: "start" | "end"
    readonly place: (middle: number | null) => void
    readonly onInset: (listener: (inset: number) => void) => () => void
  }
  // Optional. `listener` hears whether a screen reader or other assistive technology runs,
  // as the system tells the app: at once with the current state, and again on each change;
  // returns the stop. Absent where nothing can tell, as in a browser.
  readonly screenReader?: (listener: (running: boolean) => void) => () => void
  // Optional. A picture of a part of the page as it's drawn now, `rect` in CSS pixels of
  // its viewport, as a JPEG `data:` address one pixel to each CSS pixel, or undefined where
  // the window draws nothing: a companion pane, whose picture stands in where it builds
  // again. Absent where nothing surrounds the page, as in a browser.
  readonly panePicture?: (rect: PaneRect) => Promise<string | undefined>
  // Optional. The desktop app's self-updates: `onOffer` hears each update the app learns
  // of, at once when one already waits and again for each newer one, and returns the
  // stop. A `ready` offer is downloaded and installs when the app next quits. An
  // `available` one the app can't install itself, so the person gets it from its release
  // page, which `openPage` opens; one with `allow` can instead be let install itself by an
  // administrator, which `allow` asks for (macOS only; absent elsewhere). `restart` is the
  // person's own choice to restart into a `ready` update now: the app quits as their quit
  // does, installing it, and opens again once it is in place (the current version again if
  // it could not be put in place). It does nothing unless the last offer is `ready` and the
  // copy installs its own updates, and nothing while a quit is already under way; it is
  // absent from apps that came before it. `channel`, where the app
  // lets the person choose, reads which releases it follows and switches them. Absent
  // where the app does not update itself, as in a browser.
  readonly updates?: {
    readonly onOffer: (listener: (offer: UpdateOffer) => void) => () => void
    readonly openPage: () => void
    readonly allow?: () => void
    readonly restart?: () => void
    readonly channel?: {
      readonly get: () => Promise<UpdateChannel>
      readonly set: (channel: UpdateChannel) => void
    }
  }
  // Optional. What is new in the version the desktop app updated to. `get` is asked once,
  // after the workspace is up, and answers the release's highlights while the person has
  // not dismissed them, else undefined (also when the notes can't be read, which the desktop app
  // tries once more a couple of minutes later in the same launch, then on a later one); it
  // can take a couple of minutes. `dismiss` marks them seen, so no later launch offers them
  // again. Absent where the app does not say, as in a browser.
  readonly whatsNew?: {
    readonly get: () => Promise<WhatsNew | undefined>
    readonly dismiss: () => void
  }
  // Optional. The version of the desktop app, asked once when Preferences needs it. Absent
  // in a browser and in a desktop app that does not say.
  readonly version?: () => Promise<string>
  // Optional. Opens the folder of the desktop app's logs in the system's file manager, for
  // the person to read them or attach them to a bug report. Absent in a browser and in a
  // desktop app that keeps none.
  readonly openLogs?: () => void
  // Optional. Whether the desktop app runs in Electron's security sandbox, asked once at
  // startup since the answer holds for the whole run. Absent in a browser and in a desktop app
  // that does not say.
  readonly sandbox?: () => Promise<SandboxState>
  // Optional. Whether the desktop app is a portable copy, asked once at startup. A portable
  // never updates itself; `install` asks the desktop app to put the installed app, which
  // does update itself, in place, keeping the workspace, and answers nothing: the desktop
  // app owns how the install goes and `onState` hears each step of it
  // (`PortableState.install`), in every window, including an install started from another
  // window or before this page was reloaded. Once `installed` (or `newer`) the installed
  // copy takes effect when the person next opens Novadeck. Nothing restarts by itself.
  // Absent in a browser and in a desktop app that is no portable copy.
  readonly portable?: {
    readonly state: () => Promise<PortableState>
    readonly onState: (listener: (state: PortableState) => void) => () => void
    readonly install: () => void
    // Optional. Opens the page to download the newest portable copy in the browser;
    // `showDataFolder` shows the folder that holds the workspace in the file manager. `news`
    // is what is new in the offered version, for the card (absent or undefined: none to
    // show). Each is absent in a desktop app from before it.
    readonly openDownload?: () => void
    readonly showDataFolder?: () => void
    readonly news?: () => Promise<WhatsNew | undefined>
  }
  // Optional. Removing the desktop app from this computer. `plan` says what that would do
  // here, asked each time Preferences opens; `run` removes the app, after the page has
  // disconnected the agents, and keeps the person's data folders when `keepData`; `quit`
  // ends the app once `run` said `removed`. Absent in a browser and in a desktop app that has no
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
  // sidebar's Files panel and feedback.
  readonly demo?: true
}

export type Backend = BackendFields & TerminalPort

// A part of the page in CSS pixels of its viewport; see `Backend.panePicture`.
export type PaneRect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

// How the page looks, for the window around it: the scheme its native parts use
// (`system` while the page follows the system, so the page keeps seeing the system's
// own), and the ground, `--color-canvas` as `#rrggbb`, that the window shows before
// the page paints.
export type WindowAppearance = {
  readonly scheme: "system" | "light" | "dark"
  readonly ground: string
  // The header's ink, as `#rrggbb`, which the window's own controls draw in where they sit
  // over the page (Windows' caption buttons).
  readonly ink?: string
}

// A desktop notification about a terminal, by its id: a title and a body, one line each.
export type Notice = {
  readonly id: string
  readonly title: string
  readonly body: string
  // True when the notification should make no sound: the person turned Novadeck's sound off,
  // or it sounded just now for another. Only an app that plays the sound (`sounds`) heeds it.
  readonly silent?: boolean
  // The sound the app's notification plays, the person's choice or else the theme's.
  // Absent plays the default.
  readonly sound?: NoticeSound
}

// How agents work with each other (the runner's `agentMode` setting, kept in step with it).
export type AgentMode = "herd" | "solo" | "swarm"

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
  // While it is not `available`: the command that installs it where the backend runs, as a
  // terminal would run it for the person.
  readonly installer?: string | undefined
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

// Why connecting failed, sorted by what the person can do about it: a transient failure
// retries on its own, a different version or a workspace a newer Novadeck used can only
// quit, or reload a page that is older than its runner, and the rest wait for Retry.
// `message` is for people; `code` and `detail` are for a bug report.
export type ConnectFailure = {
  readonly kind: "transient" | "incompatible" | "outdated" | "unauthorized" | "unknown"
  readonly message: string
  readonly code: string
  readonly detail: string
  // For an app and a runner outside each other's window: which of them to update.
  readonly update?: "app" | "runner"
  // Reloading the page mends it: a page older than its runner loads the newer one.
  readonly reload?: boolean
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
