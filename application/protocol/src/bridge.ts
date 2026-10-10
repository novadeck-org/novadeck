/**
 * The contract between a desktop host's preload script and the page. The page calls
 * `window.novadeck.requestRunner(id)`; the preload answers with a window message
 * `{ type: runnerPortMessage, id }` that carries a fresh MessagePort to the runner.
 */
export const runnerPortMessage = "novadeck:runner-port"

export type DesktopBridge = {
  requestRunner(id: string): void
  /** Asks the user to choose a folder; resolves its absolute path, or null when cancelled. */
  pickDirectory(): Promise<string | null>
  /**
   * Registers what the page finishes before its window closes or the app quits, such
   * as its last saves; the host goes on only after it resolves, or after a short wait,
   * so saves land while the runner's shells still run. Returns a function that
   * unregisters it.
   */
  beforeQuit(save: () => Promise<void>): () => void
  /**
   * Tells the window how the page looks: the scheme for native menus, title bars and the
   * page's `prefers-color-scheme` (`system` while the page follows the system), and the
   * ground as `#rrggbb`, which the window shows before the page paints. The host
   * ignores anything else.
   */
  showAppearance(appearance: {
    readonly scheme: "system" | "light" | "dark"
    readonly ground: string
  }): void
  /**
   * The path on this machine of a file the person pasted, such as one copied
   * in a file manager, or "" for one that is no file there, as a copied image's bytes.
   * Absent from hosts that came before it.
   */
  pathForFile?(file: File): string
  /**
   * Shows a desktop notification that the agent in a terminal finished: `title` and
   * `body` one line each, without control characters, at most `noticeTitleLength` and
   * `noticeBodyLength` long, and the terminal's `id`. A newer notice for the same terminal
   * replaces the one still showing. The host drops a notice that breaks these rules.
   * Absent from hosts that came before it.
   */
  showNotice?(notice: DesktopNotice): void
  /**
   * Calls `listener` with the terminal id of each notice the person clicks, once the host
   * has brought its window to the front. Returns a function that stops listening. Absent
   * from hosts that came before it.
   */
  onNoticeClick?(listener: (id: string) => void): () => void
  /**
   * Calls `listener` with each update the host learns of: at once when it already knows
   * of one, and again whenever a newer one comes. Returns a function that stops
   * listening. Absent from hosts that came before it; a build that never looks for
   * updates never calls it.
   */
  onUpdate?(listener: (update: UpdateOffer) => void): () => void
  /**
   * Restarts the app into the downloaded update: the host lets every page finish its
   * saves first, as quitting does. Does nothing unless the last offer was `ready`.
   */
  installUpdate?(): void
  /**
   * Opens the release page of the last offer's version in the browser. The host builds
   * the address from its own release repository; the page never names one. Does
   * nothing before an offer.
   */
  openUpdatePage?(): void
  /** Which releases this build follows; see `UpdateChannel`. */
  updateChannel?(): Promise<UpdateChannel>
  /**
   * Switches the releases this build follows, which the host remembers across launches,
   * and looks for an update on the new channel soon after. The host ignores anything
   * but an `UpdateChannel`.
   */
  setUpdateChannel?(channel: UpdateChannel): void
}

/**
 * Which releases a build follows: `stable` the releases promoted to stable, `early` every
 * release as it is published. Builds start on `stable`. Switching back to `stable` never
 * downgrades: the build waits until stable passes its version.
 */
export type UpdateChannel = "stable" | "early"

export const updateChannels: readonly UpdateChannel[] = ["stable", "early"]

/**
 * An update the host tells the page of. `ready`: downloaded, and installed by
 * `installUpdate` or when the app next quits. `available`: a newer release this build
 * cannot install itself, which the person installs from its release page, as for an
 * unsigned macOS app, an AppImage in a folder it cannot write, or after an install
 * failed. `notes` are the release's notes as plain-text lines, at most
 * `updateNotesLength` of them, each at most `updateNoteLength` long, without control
 * characters; empty when the release has none the host could read.
 */
export type UpdateOffer = {
  readonly kind: "ready" | "available"
  readonly version: string
  readonly notes: readonly string[]
}

/** What an update's version may be, as the host reports it: a release's semantic version. */
export const updateVersionPattern = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/

/** The most release-note lines an offer carries. */
export const updateNotesLength = 12
/** The longest release-note line an offer carries. */
export const updateNoteLength = 200

/** A desktop notification about one terminal; see `DesktopBridge.showNotice`. */
export type DesktopNotice = {
  readonly id: string
  readonly title: string
  readonly body: string
}

/** The longest notice title the host shows: a handle, a few words and a terminal's title. */
export const noticeTitleLength = 256
/** The longest notice body the host shows: the start of a reply, as the runner previews it. */
export const noticeBodyLength = 120
/** What a notice's terminal id may be: a terminal's id, as the runner and the demo name them. */
export const noticeIdPattern = /^[A-Za-z0-9_-]{1,64}$/

/** `window.novadeck` in a desktop host's page. */
export type DesktopHost = DesktopBridge & {
  /** The host's local HTTP API. */
  readonly apiUrl: string
  /** Whether the page can show web pages live, in a locked-down `<webview>`. */
  readonly livePages?: true
}
