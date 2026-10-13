export const apiUrlArgumentPrefix = "--novadeck-api-url="
export const databaseArgumentPrefix = "--novadeck-database="
/** The relay agents start for Novadeck's MCP server and hooks, as the app ships it. */
export const relayArgumentPrefix = "--novadeck-relay="
/** The manifest of the voice engine voice input installs: a file shipped with the app. */
export const voiceEngineArgumentPrefix = "--novadeck-voice-engine="
/** Where the voice engine's archive comes from: an https address ending in "/", or a folder. */
export const voiceSourceArgumentPrefix = "--novadeck-voice-source="
/** The manifest of the murmur engine murmur installs: a file shipped with the app. */
export const murmurEngineArgumentPrefix = "--novadeck-murmur-engine="
/** Where the murmur engine's archive comes from: an https address ending in "/", or a folder. */
export const murmurSourceArgumentPrefix = "--novadeck-murmur-source="

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

/**
 * Main-to-renderer report of an update offer, `{ kind, version, notes, outdatedSince? }`; see
 * main/updater.ts. A page that starts listening later asks for it on `updateRequestChannel`.
 */
export const updateOfferChannel = "novadeck:update-offer"

/** Renderer-to-main request to be told, on `updateOfferChannel`, of the last offer. */
export const updateRequestChannel = "novadeck:update-request"

/** Renderer-to-main request to restart into the downloaded update. */
export const installUpdateChannel = "novadeck:install-update"

/** Renderer-to-main request to open the release page of the last offer in the browser. */
export const openUpdatePageChannel = "novadeck:open-update-page"

/** Renderer-to-main request for the update channel the build follows; answers it. */
export const updateChannelChannel = "novadeck:update-channel"

/** Renderer-to-main request for the version of the app; answers it. */
export const versionChannel = "novadeck:version"

/** Renderer-to-main request to follow another update channel. */
export const setUpdateChannelChannel = "novadeck:set-update-channel"

/** Renderer-to-main request for whether Electron's sandbox is on; answers a `SandboxState`. */
export const sandboxChannel = "novadeck:sandbox"

/** Renderer-to-main request for whether this is a portable copy; answers a `PortableState`. */
export const portableChannel = "novadeck:portable"

/**
 * Renderer-to-main request to install the app from this portable copy; answers an
 * `InstallResult`. See main/portable.ts.
 */
export const installAppChannel = "novadeck:install-app"

/**
 * Renderer-to-main request to start the installed copy that `installAppChannel` found
 * newer, in place of this one.
 */
export const openInstalledChannel = "novadeck:open-installed"

/** Renderer-to-main request for a folder picker; answers the chosen path or null. */
export const directoryPickerChannel = "novadeck:pick-directory"

/**
 * Messages from the main process to the runner's utility process: a client's port,
 * a save of every terminal before the system session ends, or the final close.
 */
export type RunnerCommand =
  | { readonly type: "connect" }
  | { readonly type: "persist" }
  | { readonly type: "close" }
