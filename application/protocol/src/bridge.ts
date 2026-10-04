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
}

/** Present only when the host enables its debug panel for this launch. */
export type DesktopDebugBridge = {
  readonly debug: true
  /** Kills the runner process, as a crash would; false when none runs. */
  debugKillRunner(): Promise<boolean>
}

/** `window.novadeck` in a desktop host's page. */
export type DesktopHost = DesktopBridge &
  Partial<DesktopDebugBridge> & {
    /** The host's local HTTP API. */
    readonly apiUrl: string
    /** Whether the page can show web pages live, in a locked-down `<webview>`. */
    readonly livePages?: true
  }
