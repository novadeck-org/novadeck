/**
 * The decisions of a quit that puts an update in place and of a launch that comes while it
 * does (docs/auto-update.md, "Opening Novadeck while it quits into an update"), apart from
 * the app so that "a plain quit never restarts" is pinned by tests.
 */

import type { Quitting } from "../quitting.js"

/**
 * Whether the quit that begins now swaps the AppImage at once: on Linux, for the person's
 * quit (closing the last window, the menu's Quit) and only as it begins. A signal's quit
 * installs nothing, and the quit already under way has had its turn.
 */
export const swapsAtQuitStart = ({
  platform,
  orderly,
  stopping,
}: {
  readonly platform: NodeJS.Platform
  readonly orderly: boolean
  readonly stopping: boolean
}): boolean => platform === "linux" && orderly && !stopping

/**
 * Whether the person's launch is remembered to open once the update is in place: only a
 * launch that comes while the app is quitting. Before that it is an ordinary second launch,
 * and after the app has gone there is nothing to remember it in.
 */
export const rememberReopen = (wanted: boolean, stopping: boolean): boolean => wanted || stopping

/**
 * Whether the quitting app opens the new version once it is gone: only when the update was
 * put in place by this quit and a launch was remembered. A quit with no update, or that nobody
 * reopened, leaves the app closed, as does one whose runner may still be there, which never
 * asks (see `beforeQuit`).
 */
export const opensAfterQuit = ({
  placed,
  wanted,
}: {
  readonly placed: boolean
  readonly wanted: boolean
}): boolean => placed && wanted

/**
 * Whether the person's restart into the waiting update is carried out: only when the last
 * offer is `ready`, this copy installs updates itself (a portable or telling copy never
 * has a `ready` offer, and is turned away here all the same), and no quit is under way.
 */
export const restartAllowed = ({
  offer,
  mode,
  stopping,
}: {
  readonly offer: string | undefined
  readonly mode: "install" | "tell" | undefined
  readonly stopping: boolean
}): boolean => offer === "ready" && mode === "install" && !stopping

/**
 * Asks for the restart: when `restartAllowed` says so, marks the quit the person's own,
 * orderly and with a reopen wanted, and only then quits. Returns whether it did; a refused
 * call touches nothing.
 */
export const requestRestart = ({
  offer,
  mode,
  quitting,
  quit,
}: {
  readonly offer: string | undefined
  readonly mode: "install" | "tell" | undefined
  readonly quitting: Quitting
  readonly quit: () => void
}): boolean => {
  if (!restartAllowed({ offer, mode, stopping: quitting.stopping })) return false
  quitting.orderly = true
  quitting.restart = true
  quitting.reopenWanted = true
  quit()
  return true
}

/**
 * Takes a restart back, for a quit that must not open anything: the system ending the
 * session, which installs nothing either.
 */
export const dropRestart = (quitting: Quitting): void => {
  quitting.restart = false
  quitting.reopenWanted = false
}

/**
 * Whether the update was put in place by this quit, as the system's own step tells it:
 * the AppImage swapped (Linux), the bundle installed (macOS), the installer started
 * (Windows: the install call returned true, which does not say the installer then succeeds).
 */
export const placedBy = ({
  platform,
  appImageSwapped,
  macPlaced,
  installerRan,
}: {
  readonly platform: NodeJS.Platform
  readonly appImageSwapped: boolean
  readonly macPlaced: boolean
  readonly installerRan: boolean
}): boolean =>
  platform === "darwin" ? macPlaced : platform === "win32" ? installerRan : appImageSwapped

/**
 * Whether the quitting app opens its current version once it is gone: the person asked to
 * restart and the update was not put in place, so the quit did not open the new one. On
 * Windows an installer that was started owns the reopening (`--force-run`), and when it
 * fails after the app has exited, or its spawn fails or UAC is declined (electron-updater
 * reports those after the process is gone), nothing opens; the cases that do open are a
 * download that vanished or an install that never began.
 */
export const opensCurrentAfterQuit = ({
  restart,
  placed,
}: {
  readonly restart: boolean
  readonly placed: boolean
}): boolean => restart && !placed
