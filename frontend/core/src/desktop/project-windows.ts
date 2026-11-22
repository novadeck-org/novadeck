// The desktop app's project windows: each window shows one project, and a project shows in
// at most one window. The core can't import the protocol's bridge contract, so this mirrors
// its `ProjectWindowsState` and `ProjectWindowTarget`, which
// frontend/runner-adapter/src/desktop/app.test.ts checks it fits.

// What the app says of its other windows: the ids of the projects they show, and whether this
// is the window the person used last, the only one that rings, raises notifications and counts
// on the app's icon.
export type ProjectWindowsState = {
  readonly elsewhere: readonly string[]
  readonly voice: boolean
}

// A place in a project: the project, and one of its terminals, or an Inbox entry of it, when it
// names one.
export type ProjectWindowTarget = {
  readonly projectId: string
  readonly terminalId?: string
  readonly rowId?: string
  // Something an agent did: the window goes there without coming forward.
  readonly quiet?: true
}

// Before the app has said anything: the person's window is alone and has the voice.
export const aloneInWindows: ProjectWindowsState = { elsewhere: [], voice: true }

// How a swap went: `swapped` when the other window took this window's project (this one
// switches), `alone` when no other window showed the project (this one switches), `forwarded`
// when this window hadn't said what it shows, so the other window came forward instead (this one
// stays where it is).
export type ProjectWindowSwap = "swapped" | "forwarded" | "alone"

// Another window to the page, where the backend can open them. `onState`'s listener hears the
// state at once and on each change, and returns the stop.
export type ProjectWindows = {
  readonly onState: (listener: (state: ProjectWindowsState) => void) => () => void
  // Tells the app which project this window shows, as it changes (null while it shows none),
  // and the ids of the projects this page knows.
  readonly show: (projectId: string | null, known: readonly string[]) => void
  // Tells the app whether the person has project windows on, which it keeps for the next launch.
  readonly use: (on: boolean) => void
  // Opens a project in a new window, or brings forward the window that shows it.
  readonly open: (projectId: string) => void
  // Swaps this window's project with the other window's that shows `projectId`. Neither waits
  // for the other's saves: each window's changes reach the other live through the runner.
  readonly swap: (projectId: string) => Promise<ProjectWindowSwap>
  // Brings forward the window that shows the target's project, and tells it to go there; this
  // window is told when no other shows the project.
  readonly handOff: (target: ProjectWindowTarget) => void
  // Hears each place the app tells this window to go; returns the stop.
  readonly onNavigate: (listener: (target: ProjectWindowTarget) => void) => () => void
  // True in a window that is not the app's first, where the one-time things don't come up again.
  readonly extra: boolean
}
