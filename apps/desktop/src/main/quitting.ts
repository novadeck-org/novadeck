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
   * version once it is there. The launch itself could do nothing: the quitting app holds the
   * data folder.
   */
  reopenWanted: boolean
}

/** A run that is not quitting. */
export const notQuitting = (): Quitting => ({
  stopping: false,
  orderly: false,
  reopenWanted: false,
})
