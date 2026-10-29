import type { NoticeSound } from "./sounds.js"

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
   * Takes away the notice for the terminal with this `id` while it still shows, as when the
   * person answered it in the app; nothing when none shows. The host drops an id that
   * breaks `noticeIdPattern`. Absent from hosts that came before it.
   */
  closeNotice?(id: string): void
  /**
   * Resolves true while the system holds notifications back, as Do Not Disturb, Focus or
   * Focus Assist does, and false when it does not or the host cannot tell. Resolves within
   * a fraction of a second and never rejects. Absent from hosts that came before it.
   */
  notificationsQuiet?(): Promise<boolean>
  /**
   * True where the host's own notifications play Novadeck's sound, as on macOS, whose
   * system mutes it under Focus; the page then plays none of its own for them. Absent or
   * false where the host's notifications are silent. Absent from hosts that came before it.
   */
  readonly notificationsSound?: boolean
  /**
   * Shows how many items wait in the Inbox on the app's icon: the dock or launcher badge,
   * and on Windows the taskbar overlay `image`. A `count` of 0 clears it. The host drops a
   * badge that breaks `desktopBadgeOf`. Absent from hosts that came before it.
   */
  setBadge?(badge: DesktopBadge): void
  /**
   * Calls `listener` with whether the app's window has the system's focus: at once with
   * the current state, and again on each change. Unlike the page's own `document.hasFocus()`,
   * it stays true while focus is inside a frame of the page, as a page in the companion
   * pane, and turns false when the person switches to another app. Returns a function that
   * stops listening. Absent from hosts that came before it.
   */
  onWindowFocus?(listener: (focused: boolean) => void): () => void
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
  /**
   * Asks the host to let this copy install updates itself, which takes an administrator's
   * password. macOS only; absent elsewhere and from hosts that came before it. Does
   * nothing unless the last offer has `allow`. Once it succeeds the host downloads the
   * update as usual, offering `downloading` and then `ready`.
   */
  allowUpdates?(): void
  /** Which releases this build follows; see `UpdateChannel`. */
  updateChannel?(): Promise<UpdateChannel>
  /**
   * Switches the releases this build follows, which the host remembers across launches,
   * and looks for an update on the new channel soon after. The host ignores anything
   * but an `UpdateChannel`.
   */
  setUpdateChannel?(channel: UpdateChannel): void
  /**
   * What is new in this version, once: on the launches after the app updated to a release
   * whose notes name highlights, until the person dismisses it. Undefined otherwise, and
   * when the notes can't be read, which the host tries once more two minutes later in the
   * same launch and then on a later launch. The host reads the release from GitHub's API,
   * so the answer can take a couple of minutes. Absent from hosts that came before it.
   * See `WhatsNew`.
   */
  whatsNew?(): Promise<WhatsNew | undefined>
  /** Marks this version's `whatsNew` as seen, so no later launch offers it again. */
  dismissWhatsNew?(): void
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
   * share. The host answers nothing here: it pushes how the install goes in
   * `PortableState.install` to every window, through `onPortableState`. Once `installed`
   * the installed copy is in place and this copy keeps running; the installed one takes
   * effect when the person next opens Novadeck, and nothing restarts by itself. A call
   * while an install is under way, or after one ended `installed` or `newer`, does nothing.
   * From a copy that is not portable, or a sender that is not the app's own page, it does
   * nothing either.
   */
  installApp?(): void
  /**
   * Hears the portable state whenever it changes, until the returned function is called:
   * each step of an install (`PortableInstall`) in every window. Absent from hosts that do
   * not push; the page then asks `portable` again when it needs to.
   */
  onPortableState?(listener: (state: PortableState) => void): () => void
  /**
   * Opens the website's download page in the browser, on this system's portable copy, for
   * a person who would rather fetch the newest portable than install. The host builds the
   * address; the page never names one. From a copy that is not portable, or a sender that
   * is not the app's own page, it does nothing.
   */
  openPortableDownload?(): void
  /** Opens the folder that holds the person's workspace in the system's file manager. */
  showDataFolder?(): void
  /**
   * What is new in the last `available` offer's version, for a copy that cannot install it
   * itself: the highlights of the releases after this version up to it, newest first, as
   * `whatsNew` gathers them, with `from` this version. Undefined before such an offer, when
   * none of them names highlights, and when the notes can't be read. Absent from hosts that
   * came before it.
   */
  updateNews?(): Promise<WhatsNew | undefined>
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
  /**
   * Opens the folder of the app's logs in the system's file manager, for a person to read
   * them or attach them to a bug report. Absent from hosts that came before it.
   */
  openLogs?(): void
  /**
   * What goes along with a feedback note: the app's version, the OS and the architecture.
   * Present with `DesktopHost.feedback`.
   */
  feedbackAbout?(): Promise<FeedbackHostAbout>
  /**
   * Sends a feedback note: the host posts it, the page never reaches the network itself.
   * Resolves once the website took it; rejects otherwise. Present with `DesktopHost.feedback`.
   */
  sendFeedback?(note: FeedbackHostNote): Promise<void>
  /**
   * Tells the host of an error the page didn't catch, which it logs: its name, message and
   * stack, each cut to size; the host drops a report that is anything else. Absent from hosts
   * that came before it.
   */
  reportError?(error: PageError): void
  /**
   * Tells the host how the page's pool of WebGL contexts has fared, for its log: counts
   * only, each a whole number; the host drops a report that is anything else. All but
   * `onDom` are running totals since the page opened; `onDom` is the number of screens on the
   * DOM renderer for lack of a context at the moment of the report. Absent from hosts that came before it.
   */
  reportRendererPool?(stats: RendererPoolReport): void
  /**
   * A picture of what a live page shows now, as a JPEG `data:` address, for the page's
   * viewer to show in its place while it rests: the page by its view's `getWebContentsId()`,
   * scaled down to `width` pixels where it's wider. Undefined for anything but a page view
   * of the asking page, and for one that draws nothing yet. Absent from hosts that came
   * before it.
   */
  pagePicture?(page: number, width?: number): Promise<string | undefined>
  /**
   * Makes a live page's view act as a phone's, by its view's `getWebContentsId()`, or as
   * itself again: touched, with a phone's screen and browser. False for anything but a
   * page view of the asking page, and when it can't. Absent from hosts that came before it.
   */
  pagePhone?(page: number, phone: boolean): Promise<boolean>
}

/** A feedback note as it crosses to the host: the kind the person picked, or none, and the text. */
export type FeedbackHostNote = {
  readonly kind: "bug" | "idea" | "other" | null
  readonly text: string
}

/** What a host says goes along with a feedback note; `os` and `arch` as the website takes them. */
export type FeedbackHostAbout = {
  readonly version: string
  readonly os: "macos" | "windows" | "linux"
  readonly arch: string
}

/** The counts of the page's WebGL pool; see `DesktopBridge.reportRendererPool`. */
export const rendererPoolFields = [
  "waits",
  "steals",
  "swaps",
  "lost",
  "failed",
  "resizes",
  "onDom",
] as const
export type RendererPoolReport = { readonly [Field in (typeof rendererPoolFields)[number]]: number }

/** A pool report when it is one, its counts whole numbers; anything else is undefined. */
export const rendererPoolOf = (value: unknown): RendererPoolReport | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const found: Record<string, number> = {}
  for (const field of rendererPoolFields) {
    const count = (value as Record<string, unknown>)[field]
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined
    found[field] = count
  }
  return found as RendererPoolReport
}

/**
 * An error the page didn't catch: `error`, one thrown, or `rejection`, a promise that failed
 * with nothing to catch it. Never what the error was about, only what it says of itself.
 */
export type PageError = {
  readonly kind: "error" | "rejection"
  readonly name: string
  readonly message: string
  readonly stack?: string
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
 * macOS, where closing the window leaves the app running. `install` is how installing the
 * app from this copy stands in this run; the host owns it and pushes every change.
 * `dataFolder` is where the workspace is kept, as the person would find it in their file
 * manager (`~/.config/novadeck`, `C:\Users\…\AppData\Roaming\novadeck`); every copy of the
 * app, portable or installed, old or new, uses that one folder. Absent when the host can't
 * say.
 */
export type PortableState =
  | { readonly portable: false }
  | {
      readonly portable: true
      readonly version: string
      readonly run: string
      readonly install: PortableInstall
      readonly dataFolder?: string
    }

/**
 * How installing the app from a portable copy stands in this run. `idle`: not asked yet.
 * `downloading`: the installer is being fetched, `percent` (a whole number from 0 to 100)
 * along; only Windows reports this. `installing`: it is being put in place, which has no
 * size to tell. `installed`: the installed copy is in place; this copy keeps running, and
 * the installed one takes effect when the person next opens Novadeck. `newer`: an installed
 * copy of this `version`, newer than this one, was left alone, and takes effect the same
 * way. `failed`: nothing was installed, for the short human-readable `reason` given, such
 * as a full disk or a folder that cannot be written; asking again starts over.
 */
export type PortableInstall =
  | { readonly phase: "idle" }
  | { readonly phase: "downloading"; readonly percent: number }
  | { readonly phase: "installing" }
  | { readonly phase: "installed" }
  | { readonly phase: "newer"; readonly version: string }
  | { readonly phase: "failed"; readonly reason: string }

/** The longest data folder path the host shows; a longer one is no path. */
export const portablePathLength = 1024

/** What a run's name may be, as the host reports it: a UUID. */
export const portableRunPattern = /^[0-9A-Fa-f-]{1,64}$/

/** The longest reason a failed install shows; a longer one is cut short with an ellipsis. */
export const installReasonLength = 300

/** What the page shows for a failed install whose reason it cannot show. */
export const unknownInstallReason = "Something went wrong."

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
 * Which releases a build follows: `stable` the releases promoted to stable, `experimental` every
 * release as it is published. Builds start on `stable`. Switching back to `stable` never
 * downgrades: the build waits until stable passes its version.
 */
export type UpdateChannel = "stable" | "experimental"

export const updateChannels: readonly UpdateChannel[] = ["stable", "experimental"]

/**
 * An update the host tells the page of. `downloading`: a release the host is downloading,
 * `percent` (a whole number from 0 to 100) along; it turns `ready` once downloaded, or
 * `retrying` should the download fail. `ready`: downloaded, and installed when the app
 * next quits. `retrying`: a download failed and the host will try again by itself, so the
 * person has nothing to do and the page shows nothing for it. `available`: a newer release
 * the person must fetch themselves, because this build cannot install it: an unsigned
 * macOS app, an AppImage in a folder it cannot write, a portable copy, or an install that
 * failed. `allow`, only on `available`: an administrator can let this copy install updates
 * itself (a macOS copy its person cannot write to), and `allowUpdates` asks.
 */
export type UpdateOffer =
  | { readonly kind: "downloading"; readonly version: string; readonly percent: number }
  | { readonly kind: "ready" | "retrying"; readonly version: string }
  | { readonly kind: "available"; readonly version: string; readonly allow?: true }

/** Whether `value` is how far along a download is: a whole percent from 0 to 100. */
export const isUpdatePercent = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100

/** What an update's version may be, as the host reports it: a release's semantic version. */
export const updateVersionPattern = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/

// Control and format characters, which include the marks that reorder text, and the line
// and paragraph separators.
const unwanted = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isVersion = (value: unknown): value is string =>
  typeof value === "string" && updateVersionPattern.test(value)

/**
 * The offer when it is one the contract allows, else undefined. The host builds offers
 * that obey it; the preload and the page both hold what crosses the bridge to it, should
 * the host be wrong or tricked.
 */
export const parseUpdateOffer = (value: unknown): UpdateOffer | undefined => {
  if (!isRecord(value)) return undefined
  const { kind, version, percent, allow } = value
  if (!isVersion(version)) return undefined
  if (kind === "downloading")
    return isUpdatePercent(percent) ? { kind, version, percent } : undefined
  if (kind === "available") return allow === true ? { kind, version, allow } : { kind, version }
  if (kind === "ready" || kind === "retrying") return { kind, version }
  return undefined
}

/**
 * A failed install's reason as one plain line the page can show: control, format and
 * separator characters become spaces, runs of space collapse, and a reason longer than
 * `installReasonLength` is cut short with an ellipsis. One left empty is
 * `unknownInstallReason`.
 */
const reasonLine = (reason: unknown): string => {
  if (typeof reason !== "string") return unknownInstallReason
  const line = reason.replace(new RegExp(unwanted.source, "gu"), " ").replace(/\s+/g, " ").trim()
  if (line === "") return unknownInstallReason
  const points = Array.from(line)
  if (points.length <= installReasonLength) return line
  return `${points
    .slice(0, installReasonLength - 1)
    .join("")
    .trimEnd()}…`
}

/** How an install stands when it is one the contract allows, else undefined. */
export const parsePortableInstall = (value: unknown): PortableInstall | undefined => {
  if (!isRecord(value)) return undefined
  const { phase, percent, version, reason } = value
  if (phase === "idle" || phase === "installing" || phase === "installed") return { phase }
  if (phase === "downloading") return isUpdatePercent(percent) ? { phase, percent } : undefined
  if (phase === "newer") return isVersion(version) ? { phase, version } : undefined
  return phase === "failed" ? { phase, reason: reasonLine(reason) } : undefined
}

// A path the host shows as one plain line, or undefined when it is none.
const pathLine = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= portablePathLength &&
  !new RegExp(unwanted.source, "u").test(value)
    ? value
    : undefined

/**
 * The portable state when it is one the contract allows, else undefined; each side picks
 * what a broken answer counts as. A `dataFolder` that is no plain path is left out.
 */
export const parsePortableState = (value: unknown): PortableState | undefined => {
  if (!isRecord(value)) return undefined
  const { portable, version, run, install, dataFolder } = value
  if (portable === false) return { portable: false }
  if (portable !== true || !isVersion(version)) return undefined
  if (typeof run !== "string" || !portableRunPattern.test(run)) return undefined
  const parsed = parsePortableInstall(install)
  if (!parsed) return undefined
  const folder = pathLine(dataFolder)
  return {
    portable: true,
    version,
    run,
    install: parsed,
    ...(folder === undefined ? {} : { dataFolder: folder }),
  }
}

/**
 * What is new in the version the app updated to: its release's highlights, each a short
 * title and one plain line, as the release notes give them (scripts/release-notes). One to
 * `whatsNewHighlights` of them; text only, never Markdown or links. `from` is the version
 * they are new since, when the host knows it: the one updated from, or the newest whose
 * notes were already seen when that is newer.
 */
export type WhatsNew = {
  readonly version: string
  readonly from?: string
  readonly highlights: readonly WhatsNewHighlight[]
}

/**
 * A highlight may lead with an icon, by its Lucide name from the notes' set (`highlightIcons`
 * in release-notes.ts). Only its shape is checked here, so the preload carries no schema
 * library: the host reads the notes with the set, and the page draws a name it doesn't know
 * as its fallback.
 */
export type WhatsNewHighlight = {
  readonly title: string
  readonly line: string
  readonly icon?: string
}

/** What a highlight's icon may be: a Lucide name, lowercase words and digits joined by `-`. */
const iconName = /^(?=.{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The most highlights a release names. */
export const whatsNewHighlights = 4
/** The longest highlight title the page shows. */
export const whatsNewTitleLength = 80
/** The longest highlight line the page shows. */
export const whatsNewLineLength = 240

// A highlight's text as one plain line: control, format and separator characters become
// spaces and runs of space collapse. Empty or too long, it is no highlight.
const highlightText = (value: unknown, length: number): string | undefined => {
  if (typeof value !== "string") return undefined
  const text = value.replace(new RegExp(unwanted.source, "gu"), " ").replace(/\s+/g, " ").trim()
  return text !== "" && Array.from(text).length <= length ? text : undefined
}

/**
 * What is new when it is something the contract allows, else undefined. Highlights that
 * break it are left out first, then the most that is shown are kept, so a valid one never
 * gives way to an invalid one before it. With none left there is nothing to show. A `from`
 * that is no version, or the version itself, is left out: the card then names none.
 */
export const parseWhatsNew = (value: unknown): WhatsNew | undefined => {
  if (!isRecord(value) || !isVersion(value.version) || !Array.isArray(value.highlights))
    return undefined
  const highlights = value.highlights
    .flatMap((highlight: unknown): WhatsNewHighlight[] => {
      if (!isRecord(highlight)) return []
      const title = highlightText(highlight.title, whatsNewTitleLength)
      const line = highlightText(highlight.line, whatsNewLineLength)
      if (!title || !line) return []
      const { icon } = highlight
      return [
        typeof icon === "string" && iconName.test(icon) ? { title, line, icon } : { title, line },
      ]
    })
    .slice(0, whatsNewHighlights)
  if (highlights.length === 0) return undefined
  const { from } = value
  return isVersion(from) && from !== value.version
    ? { version: value.version, from, highlights }
    : { version: value.version, highlights }
}

/** A desktop notification about one terminal; see `DesktopBridge.showNotice`. */
export type DesktopNotice = {
  readonly id: string
  readonly title: string
  readonly body: string
  /**
   * True when this notification should make no sound: the person turned Novadeck's sound
   * off, or it sounded just now for another. Absent or false leaves it to the host, which
   * plays one only where its notifications play Novadeck's sound (see
   * `DesktopBridge.notificationsSound`).
   */
  readonly silent?: boolean
  /**
   * The sound to play, the person's choice or else the theme's, where the host's
   * notifications play one. The host drops an id outside `noticeSounds`, and absent plays
   * `defaultNoticeSound`.
   */
  readonly sound?: NoticeSound
}

/** The longest notice title the host shows: a handle, a few words and a terminal's title. */
export const noticeTitleLength = 256
/** The longest notice body the host shows: the start of a reply, as the runner previews it. */
export const noticeBodyLength = 120
/** What a notice's terminal id may be: a terminal's id, as the runner and the demo name them. */
export const noticeIdPattern = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The app icon's badge; see `DesktopBridge.setBadge`. `count` is a whole number from 0 to
 * `badgeMaxCount`, 0 clearing the badge. `image` is a PNG data URL of at most
 * `badgeImageLength` characters for Windows' taskbar overlay, which has no text, or null.
 */
export type DesktopBadge = {
  readonly count: number
  readonly image: string | null
}

/** The largest count a badge carries. */
export const badgeMaxCount = 999
/** The longest badge image, as a data URL: a small overlay icon. */
export const badgeImageLength = 16384

const badgeImagePattern = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/

/**
 * The badge when the value is one, or undefined: a whole `count` from 0 to
 * `badgeMaxCount` and an `image` that is null or a base64 PNG data URL within
 * `badgeImageLength`. Nothing else of the value passes. The page and the host both use it.
 */
export const desktopBadgeOf = (value: unknown): DesktopBadge | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { count, image } = value as Record<string, unknown>
  if (typeof count !== "number" || !Number.isInteger(count)) return undefined
  if (count < 0 || count > badgeMaxCount) return undefined
  if (image === null) return { count, image }
  if (typeof image !== "string" || image.length > badgeImageLength) return undefined
  return badgeImagePattern.test(image) ? { count, image } : undefined
}

/** `window.novadeck` in a desktop host's page. */
export type DesktopHost = DesktopBridge & {
  /** The host's local HTTP API. */
  readonly apiUrl: string
  /** Whether the page can show web pages live, in a locked-down `<webview>`. */
  readonly livePages?: true
  /**
   * How many live WebGL contexts the host's Chromium allows this page, when the host raised
   * the limit from the browser's 16; see `webglContextsOf`. Absent in a browser and from
   * hosts that came before it.
   */
  readonly webglContexts?: number
  /**
   * True when the host sends the person's feedback notes to the Novadeck website, so the
   * page offers the footer's card: `feedbackAbout` and `sendFeedback` work. Absent where it
   * does not (a development run without a feedback address) and from hosts that came before it.
   */
  readonly feedback?: true
}

/** The fewest and most WebGL contexts a host may say its page is allowed. */
export const webglContextsRange = { min: 3, max: 1024 } as const

/** A WebGL context limit when it is a whole number in `webglContextsRange`; otherwise undefined. */
export const webglContextsOf = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= webglContextsRange.min &&
  value <= webglContextsRange.max
    ? value
    : undefined
