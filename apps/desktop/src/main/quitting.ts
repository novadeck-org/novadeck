/**
 * How the app's quit stands, which the windows, the updates and the uninstall all read. One
 * record for the app's run, made by the main process's entry and handed to each of them.
 */
export type Quitting = {
  /**
   * Whether the app is shutting down: every page saves, then the runner ends its shells.
   * Set once, as the quit or the uninstall begins.
   */
  stopping: boolean
  /**
   * Whether the quit under way began the orderly way: closing the last window, or the
   * menu's Quit. On Linux Electron turns SIGTERM, SIGINT and SIGHUP into an ordinary quit,
   * which must not install an update; see ./updates/updater.ts.
   */
  orderly: boolean
  /**
   * Whether the person opened Novadeck while it was quitting (a second launch, or the Dock
   * icon on macOS), which a quit that puts an update in place answers by opening the new
   * version once it is there, unless its runner may still be running. The launch itself could
   * do nothing: the quitting app holds the data folder.
   */
  reopenWanted: boolean
  /**
   * Whether the person chose to restart into a waiting update, which opens Novadeck again
   * whatever comes of the update: the new version once it is in place, the current one if
   * it could not be. Implies `orderly` and `reopenWanted`.
   */
  restart: boolean
}

/** A run that is not quitting. */
export const notQuitting = (): Quitting => ({
  stopping: false,
  orderly: false,
  reopenWanted: false,
  restart: false,
})
