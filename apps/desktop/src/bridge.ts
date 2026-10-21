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
/** Given as `software` when the host saw no graphics hardware, so murmur can't run and voice input goes straight to its small model; absent otherwise. */
export const graphicsArgumentPrefix = "--novadeck-graphics="

/**
 * How the runner writes its log: a `LogSetup` as JSON (see ./logging.ts), naming the logs
 * folder, the launch and which start of the runner this is.
 */
export const logArgumentPrefix = "--novadeck-log="

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
 * Main-to-renderer report of an update offer, `{ kind, version, notes }`; see
 * main/updater.ts. A page that starts listening later asks for it on `updateRequestChannel`.
 */
export const updateOfferChannel = "novadeck:update-offer"

/** Renderer-to-main request to be told, on `updateOfferChannel`, of the last offer. */
export const updateRequestChannel = "novadeck:update-request"

/** Renderer-to-main request to open the release page of the last offer in the browser. */
export const openUpdatePageChannel = "novadeck:open-update-page"

/**
 * Renderer-to-main request for what is new in the version the app updated to; answers a
 * `WhatsNew` or undefined. See main/whats-new.ts.
 */
export const whatsNewChannel = "novadeck:whats-new"

/** Renderer-to-main report that the person has seen what is new; nothing is answered. */
export const dismissWhatsNewChannel = "novadeck:dismiss-whats-new"

/** Renderer-to-main request to let this copy install updates itself, by an administrator's password. */
export const allowUpdatesChannel = "novadeck:allow-updates"

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
 * Renderer-to-main request to install the app from this portable copy; answers nothing,
 * as every step arrives on `portableStateChannel`. See main/portable.ts.
 */
export const installAppChannel = "novadeck:install-app"

/**
 * Main-to-renderer report of the portable state, a `PortableState`, whenever it changes,
 * which includes each step of an install; see main/portable.ts.
 */
export const portableStateChannel = "novadeck:portable-state"

/**
 * Renderer-to-main request for what uninstalling this copy would do; answers an
 * `UninstallPlan`. See main/uninstall.ts.
 */
export const uninstallPlanChannel = "novadeck:uninstall-plan"

/**
 * Renderer-to-main request to remove the app, `{ keepData }`; answers an `UninstallResult`.
 */
export const uninstallAppChannel = "novadeck:uninstall-app"

/** Renderer-to-main request to quit the app, once it has been uninstalled. */
export const quitAppChannel = "novadeck:quit-app"

/** Renderer-to-main request for a folder picker; answers the chosen path or null. */
export const directoryPickerChannel = "novadeck:pick-directory"

/** Renderer-to-main request to open the logs folder in the system's file manager. */
export const openLogsChannel = "novadeck:open-logs"

/**
 * Renderer-to-main request for a picture of a live page, by its view's web contents id;
 * answers a JPEG `data:` address or undefined. See the viewers' `picturePage`.
 */
export const pagePictureChannel = "novadeck:page-picture"

/**
 * Renderer-to-main report of an error the page didn't catch, `{ kind, name, message, stack }`,
 * which the host logs; see main/ui-errors.ts.
 */
export const uiErrorChannel = "novadeck:ui-error"

/**
 * Messages from the main process to the runner's utility process: a client's port,
 * a save of every terminal before the system session ends, or the final close; and the
 * key saved transcripts are encrypted with, base64 or null where none can be kept safe,
 * sent here rather than in an argument or the environment, which other processes can read.
 */
export type RunnerCommand =
  | { readonly type: "connect" }
  | { readonly type: "transcriptKey"; readonly key: string | null }
  | { readonly type: "persist" }
  | { readonly type: "close" }

/** Messages from the runner's utility process to the main process: it is ready to serve. */
export type RunnerReport = { readonly type: "ready" }
