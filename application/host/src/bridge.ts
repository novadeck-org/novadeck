export const apiUrlArgumentPrefix = "--novadeck-api-url="
export const databaseArgumentPrefix = "--novadeck-database="

/** Renderer-to-main request for a runner port; the answer arrives on the same channel. */
export const runnerPortChannel = "novadeck:runner-port"

/** Messages from the main process to the runner's utility process. */
export type RunnerCommand = { readonly type: "connect" } | { readonly type: "close" }
