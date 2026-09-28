export const apiUrlArgumentPrefix = "--novadeck-api-url="
export const databaseArgumentPrefix = "--novadeck-database="

/** Renderer-to-main request for a runner port; the answer arrives on the same channel. */
export const runnerPortChannel = "novadeck:runner-port"

/**
 * Main-to-renderer request, before a window closes or the app quits, to finish the
 * page's saves while its shells still run; the page answers on the same channel once
 * they have landed.
 */
export const saveBeforeQuitChannel = "novadeck:save-before-quit"

/** Renderer-to-main request for a folder picker; answers the chosen path or null. */
export const directoryPickerChannel = "novadeck:pick-directory"

/** Passed to the page when the debug panel is enabled; see main/debug.ts. */
export const debugArgument = "--novadeck-debug"
/** Debug panel: renderer-to-main request to kill the runner utility process. */
export const debugKillRunnerChannel = "novadeck:debug-kill-runner"

/** Messages from the main process to the runner's utility process. */
export type RunnerCommand = { readonly type: "connect" } | { readonly type: "close" }
