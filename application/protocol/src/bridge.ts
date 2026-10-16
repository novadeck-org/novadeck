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
  /**
   * The version of the app, as a release is named. Absent from hosts that came before it.
   */
  version?(): Promise<string>
  /**
   * Whether Electron's sandbox is on for this window. Absent from hosts that came
   * before it. See `SandboxState`.
   */
  sandbox?(): Promise<SandboxState>
  /**
   * Whether this copy of the app is a portable one: it runs from wherever it was put,
   * never installs updates itself, and can install the app that does. Absent from hosts
   * that came before it; the page then takes the app for an installed one. Hosts that have
   * it answer `{ portable: false }` for a copy that was installed. See
   * `PortableState`.
   */
  portable?(): Promise<PortableState>
  /**
   * Installs the app from this portable copy, keeping the person's workspace, which both
   * share. On `installed` the installed copy is in place and this copy keeps running;
   * the installed one takes effect when the person next opens Novadeck, and nothing
   * restarts by itself. On `newer` an installed copy newer than this one exists and
   * nothing was written; it takes effect when the person next opens Novadeck too. A
   * second call while an install is under way does nothing more, and one after `installed`
   * answers the same again. From a copy that is not portable, or a sender that is not the app's
   * own page, the answer is `failed`. See `InstallResult`.
   */
  installApp?(): Promise<InstallResult>
  /**
   * Hears how far an install under way has got, until the returned function is called.
   * Only some hosts report a download (`InstallProgress`); the page shows a wait without
   * a size where there is none. Absent from hosts that do not report.
   */
  onInstallProgress?(listener: (progress: InstallProgress) => void): () => void
  /**
   * Hears the portable state whenever it changes, until the returned function is called:
   * an install that answered `installed` or `newer` makes `installed` true for the rest of
   * the run, in every window. Absent from hosts that do not push; the page then asks
   * `portable` again when it needs to.
   */
  onPortableState?(listener: (state: PortableState) => void): () => void
  /**
   * What uninstalling this copy of the app would do, or why it can't be done from here.
   * Absent from hosts that came before it. See `UninstallPlan`.
   */
  uninstallPlan?(): Promise<UninstallPlan>
  /**
   * Removes the app from this computer, after the page has disconnected the agents it
   * connected. The host saves every page and ends the runner's shells first, as quitting
   * does, then removes the install and, unless `keepData`, the person's data folders.
   * From a copy whose plan was not `ready`, or a sender that is not the app's own page,
   * the answer is `failed` and nothing is touched. See `UninstallResult`.
   */
  uninstallApp?(options: { readonly keepData: boolean }): Promise<UninstallResult>
  /** Quits the app after the host's shutdown; the page offers it once `uninstallApp` answered `removed`. */
  quitApp?(): void
}

/**
 * What uninstalling this copy would do. `unavailable`: nothing from here, as for a
 * portable copy or a development run, which have no install to remove. `manual`: another
 * tool installed it, so the person runs `command` (such as `brew uninstall --cask
 * novadeck`) in a terminal. `ready`: the host can remove it; `dataFolders` are the
 * absolute paths of the person's projects and sessions that `keepData: false` would also
 * delete (empty when the app runs with a data folder of the person's own choosing, which
 * it never deletes), and `handoff` says who removes the app: `app`, the running app itself (Linux,
 * macOS), or `uninstaller`, the platform's own uninstaller, which the host starts and
 * then quits for (Windows).
 */
export type UninstallPlan =
  | { readonly kind: "unavailable" }
  | { readonly kind: "manual"; readonly command: string }
  | {
      readonly kind: "ready"
      readonly dataFolders: readonly string[]
      readonly handoff: "app" | "uninstaller"
    }

/**
 * How `uninstallApp` went. `uninstalling`: the platform's uninstaller was started and the
 * app is quitting for it, so the page has nothing more to do. `removed`: the app's
 * files are gone and it still runs only to say so; `leftover`, when present, is a
 * one-line shell command the host could not run itself, such as removing the AppArmor
 * profile that needs a password, for the person to run in a terminal. `failed`: it
 * stopped for the short human-readable `reason`, and what it had not reached is intact
 * (the agents were disconnected before it was called).
 */
export type UninstallResult =
  | { readonly kind: "uninstalling" }
  | { readonly kind: "removed"; readonly leftover?: string }
  | { readonly kind: "failed"; readonly reason: string }

/**
 * Whether the host runs as a portable copy. `version` is this build's, reported for
 * display and diagnostics. `run` names this run of the app and is new at each launch of it;
 * a page tells with it a window opened again within one run from a new launch, as on
 * macOS, where closing the window leaves the app running. `installed` is whether this run
 * already installed the app.
 */
export type PortableState =
  | { readonly portable: false }
  | {
      readonly portable: true
      readonly version: string
      readonly run: string
      /** Whether this run already installed the app (or found a newer one installed), so a window opened again shows it done. */
      readonly installed: boolean
    }

/** What a run's name may be, as the host reports it: a UUID. */
export const portableRunPattern = /^[0-9A-Fa-f-]{1,64}$/

/**
 * How `installApp` went. `installed`: the installed copy is in place; this copy keeps
 * running, and the installed one takes effect when the person next opens Novadeck.
 * `newer`: an installed copy of this `version`, newer than this one,
 * was left alone. `failed`: nothing was installed, for the short human-readable
 * `reason` given, such as a full disk or a folder that cannot be written.
 */
export type InstallResult =
  | { readonly kind: "installed" }
  | { readonly kind: "newer"; readonly version: string }
  | { readonly kind: "failed"; readonly reason: string }

/**
 * How far an install under way has got. `downloading`: the installer is being fetched,
 * `percent` (a whole number from 0 to 100) along; only Windows reports this. `installing`:
 * it is being put in place, which has no size to tell.
 */
export type InstallProgress =
  | { readonly phase: "downloading"; readonly percent: number }
  | { readonly phase: "installing" }

/**
 * Whether the host runs with Electron's sandbox. It does not when started with
 * `--no-sandbox`, as the Linux AppImage launcher does on a system that restricts
 * unprivileged user namespaces, such as Ubuntu 24.04 and later. `fix` is the one-line
 * shell command that turns the sandbox on, for the person to run in a terminal; empty
 * when the host has none to offer.
 */
export type SandboxState =
  | { readonly sandboxed: true }
  | { readonly sandboxed: false; readonly fix: string }

/**
 * Which releases a build follows: `stable` the releases promoted to stable, `early` every
 * release as it is published. Builds start on `stable`. Switching back to `stable` never
 * downgrades: the build waits until stable passes its version.
 */
export type UpdateChannel = "stable" | "early"

export const updateChannels: readonly UpdateChannel[] = ["stable", "early"]

/**
 * An update the host tells the page of. `downloading`: a release the host is downloading,
 * `percent` (a whole number from 0 to 100) along; it turns `ready` once downloaded, or
 * `retrying` should the download fail. `ready`: downloaded, and installed when the app
 * next quits. `retrying`: a download failed and the host will try again by itself, so the
 * person has nothing to do and the page shows nothing for it. `available`: a newer release
 * the person must fetch themselves, because this build cannot install it: an unsigned
 * macOS app, an AppImage in a folder it cannot write, a portable copy, or an install that
 * failed.
 */
export type UpdateOffer = {
  readonly kind: UpdateOfferKind
  readonly version: string
  /** Set only for `downloading`. */
  readonly percent?: number
}

export type UpdateOfferKind = "downloading" | "ready" | "retrying" | "available"

/** Whether `value` is how far along a download is: a whole percent from 0 to 100. */
export const isUpdatePercent = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100

/** What an update's version may be, as the host reports it: a release's semantic version. */
export const updateVersionPattern = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/

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
