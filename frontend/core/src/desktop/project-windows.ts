// The desktop app's project windows: each window shows one project, and a project may show
// in several windows. The core can't import the protocol's bridge contract, so this mirrors
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

// Another window to the page, where the backend can open them. `onState`'s listener hears the
// state at once and on each change, and returns the stop.
export type ProjectWindows = {
  readonly onState: (listener: (state: ProjectWindowsState) => void) => () => void
  // Tells the app which project this window shows, as it changes (null while it shows none),
  // and the ids of the projects this page knows.
  readonly show: (projectId: string | null, known: readonly string[]) => void
  // Opens a project in a new window, even when a window shows it already.
  readonly open: (projectId: string) => void
  // Sends a place in a project to this window when it shows the project, else to the window
  // showing it that was used last, which comes forward, else to this window.
  readonly handOff: (target: ProjectWindowTarget) => void
  // Hears each place the app tells this window to go; returns the stop.
  readonly onNavigate: (listener: (target: ProjectWindowTarget) => void) => () => void
  // True in a window that is not the app's first, where the one-time things don't come up again.
  readonly extra: boolean
}
