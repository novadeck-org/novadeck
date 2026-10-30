/**
 * The decisions of a quit that puts an update in place and of a launch that comes while it
 * does (docs/auto-update.md, "Opening Novadeck while it quits into an update"), apart from
 * the app so that "a plain quit never restarts" is pinned by tests.
 */

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
 * reopened, leaves the app closed.
 */
export const opensAfterQuit = ({
  placed,
  wanted,
}: {
  readonly placed: boolean
  readonly wanted: boolean
}): boolean => placed && wanted
