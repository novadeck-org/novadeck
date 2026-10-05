export const apiUrlArgumentPrefix = "--novadeck-api-url="
export const databaseArgumentPrefix = "--novadeck-database="
/** The relay agents start for NovaDeck's MCP server and hooks, as the app ships it. */
export const relayArgumentPrefix = "--novadeck-relay="

/** Renderer-to-main request for a runner port; the answer arrives on the same channel. */
export const runnerPortChannel = "novadeck:runner-port"

/**
 * Main-to-renderer request, before a window closes or the app quits, to finish the
 * page's saves while its shells still run; the page answers on the same channel once
 * they have landed.
 */
export const saveBeforeQuitChannel = "novadeck:save-before-quit"

/**
 * Renderer-to-main report of how the page looks, `{ scheme, ground }`, which the window
 * follows; see main/appearance.ts.
 */
export const appearanceChannel = "novadeck:appearance"

/**
 * Renderer-to-main request to show a desktop notification about a terminal,
 * `{ id, title, body }`; see main/notices.ts.
 */
export const noticeChannel = "novadeck:notice"

/** Main-to-renderer report of the terminal id of a notification the person clicked. */
export const noticeClickChannel = "novadeck:notice-click"

/** Renderer-to-main request for a folder picker; answers the chosen path or null. */
export const directoryPickerChannel = "novadeck:pick-directory"

/** Passed to the page when the debug panel is enabled; see main/debug.ts. */
export const debugArgument = "--novadeck-debug"
/** Debug panel: renderer-to-main request to kill the runner utility process. */
export const debugKillRunnerChannel = "novadeck:debug-kill-runner"

/**
 * Messages from the main process to the runner's utility process: a client's port,
 * a save of every terminal before the system session ends, or the final close.
 */
export type RunnerCommand =
  | { readonly type: "connect" }
  | { readonly type: "persist" }
  | { readonly type: "close" }
