import type { WindowControlsSide } from "@novadeck/protocol/bridge"

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
/** Given as `software` when the app saw no graphics hardware, so murmur can't run and voice input goes straight to its small model; absent otherwise. */
export const graphicsArgumentPrefix = "--novadeck-graphics="

/** Given to the page's preload when the app sends feedback notes: the value is `1`; absent otherwise. */
export const feedbackArgumentPrefix = "--novadeck-feedback="

/** Renderer-to-main request for what goes along with a feedback note; answers it. */
export const feedbackAboutChannel = "novadeck:feedback-about"

/** Renderer-to-main request to send a feedback note, `{ kind, text }`; rejects when it did not go. */
export const feedbackSendChannel = "novadeck:feedback-send"

/** Given to the page's preload: how many WebGL contexts Chromium allows the page, a whole number. */
export const webglContextsArgumentPrefix = "--novadeck-webgl-contexts="

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
 * follows; see main/window/appearance.ts.
 */
export const appearanceChannel = "novadeck:appearance"

/**
 * Renderer-to-main report of the scale the person chose for the app, a fraction of its normal
 * size, which every window shows; see main/window/scale.ts.
 */
export const scaleChannel = "novadeck:scale"

/**
 * Renderer-to-main request to show a desktop notification about a terminal,
 * `{ id, title, body }`; see main/notices/notices.ts.
 */
export const noticeChannel = "novadeck:notice"

/**
 * Renderer-to-main request to take away the notification still showing for a terminal,
 * its id as a string; see main/notices/notices.ts.
 */
export const noticeCloseChannel = "novadeck:notice-close"

/**
 * Renderer-to-main question whether the system holds notifications back (Do Not Disturb,
 * Focus), answered with a boolean; see main/notices/quiet.ts.
 */
export const notificationsQuietChannel = "novadeck:notifications-quiet"

/**
 * Renderer-to-main report of the Inbox count for the app icon, `{ count, image }`; see
 * main/notices/badge.ts.
 */
export const badgeChannel = "novadeck:badge"

/**
 * Main-to-renderer report of whether the app's window has the system's focus, a boolean,
 * sent on each change; see main/window/focus.ts. A page that starts listening asks for the
 * current one on `windowFocusRequestChannel`.
 */
export const windowFocusChannel = "novadeck:window-focus"

/** Renderer-to-main request to be told, on `windowFocusChannel`, of the window's focus. */
export const windowFocusRequestChannel = "novadeck:window-focus-request"

/**
 * Main-to-renderer report of whether a screen reader or other assistive technology is
 * running, a boolean, sent on each change; see main/window/screen-reader.ts. A page that
 * starts listening asks for the current one on `screenReaderRequestChannel`.
 */
export const screenReaderChannel = "novadeck:screen-reader"

/** Renderer-to-main request to be told, on `screenReaderChannel`, whether one is running. */
export const screenReaderRequestChannel = "novadeck:screen-reader-request"

/**
 * Whether the app can tell when a screen reader runs: Electron reports assistive technology on
 * macOS and Windows, and on Linux the app reads the desktop's accessibility bus. Elsewhere the
 * page hears nothing and keeps a reader's text.
 */
export const tellsScreenReader = (platform: string): boolean =>
  platform === "darwin" || platform === "win32" || platform === "linux"

/**
 * The edge of the page's top the app's window puts its own controls over, the page's header
 * standing in for a title bar: the start on macOS, the end on Windows. Undefined where the
 * window keeps the system's title bar, as on Linux.
 */
export const windowControlsSide = (platform: string): WindowControlsSide | undefined =>
  platform === "darwin" ? "start" : platform === "win32" ? "end" : undefined

/**
 * Main-to-renderer report of the room the window's controls take from the page's edge on their
 * side, in CSS pixels, 0 while they don't show; see main/window/controls.ts. Sent on each change
 * and in answer to each `windowControlsPlaceChannel` request.
 */
export const windowControlsChannel = "novadeck:window-controls"

/**
 * Renderer-to-main request to centre the window's controls on a line that many CSS pixels
 * below the page's top, or to hide them (null).
 */
export const windowControlsPlaceChannel = "novadeck:window-controls-place"

/** Main-to-renderer report of the terminal id of a notification the person clicked. */
export const noticeClickChannel = "novadeck:notice-click"

/**
 * Main-to-renderer report of an update offer, `{ kind, version, notes }`; see
 * main/updates/updater.ts. A page that starts listening later asks for it on `updateRequestChannel`.
 */
export const updateOfferChannel = "novadeck:update-offer"

/** Renderer-to-main request to be told, on `updateOfferChannel`, of the last offer. */
export const updateRequestChannel = "novadeck:update-request"

/** Renderer-to-main request to open the release page of the last offer in the browser. */
export const openUpdatePageChannel = "novadeck:open-update-page"

/**
 * Renderer-to-main request for what is new in the version the app updated to; answers a
 * `WhatsNew` or undefined. See main/updates/whats-new.ts.
 */
export const whatsNewChannel = "novadeck:whats-new"

/** Renderer-to-main report that the person has seen what is new; nothing is answered. */
export const dismissWhatsNewChannel = "novadeck:dismiss-whats-new"

/** Renderer-to-main request to let this copy install updates itself, by an administrator's password. */
export const allowUpdatesChannel = "novadeck:allow-updates"

/** Renderer-to-main request to quit and open again as the waiting update; nothing is answered. */
export const restartToUpdateChannel = "novadeck:restart-to-update"

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
 * as every step arrives on `portableStateChannel`. See main/portable/installer.ts.
 */
export const installAppChannel = "novadeck:install-app"

/** Renderer-to-main request to open the website's download page for this system's portable copy; answers nothing. */
export const openPortableDownloadChannel = "novadeck:open-portable-download"

/** Renderer-to-main request to open the folder that holds the person's workspace. */
export const showDataFolderChannel = "novadeck:show-data-folder"

/**
 * Renderer-to-main request for what is new in the version a portable copy is offered;
 * answers a `WhatsNew` or undefined. See main/updates/whats-new.ts.
 */
export const updateNewsChannel = "novadeck:update-news"

/**
 * Main-to-renderer report of the portable state, a `PortableState`, whenever it changes,
 * which includes each step of an install; see main/portable/installer.ts.
 */
export const portableStateChannel = "novadeck:portable-state"

/**
 * Renderer-to-main request for what uninstalling this copy would do; answers an
 * `UninstallPlan`. See main/install/uninstall.ts.
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
 * Renderer-to-main request for a picture of a live page, by its view's web contents id, no
 * wider than a width; answers a JPEG `data:` address or undefined. A third argument, `true`,
 * says the picture is for an agent's look: none is taken while the page holds a frame from
 * off this machine. See the viewers' `picturePage`.
 */
export const pagePictureChannel = "novadeck:page-picture"

/**
 * Renderer-to-main request for a picture of a part of the app's own page, `{ x, y, width,
 * height }` in CSS pixels of its viewport, as a companion pane is drawn there now; answers a
 * JPEG `data:` address or undefined. See `picturePane`.
 */
export const panePictureChannel = "novadeck:pane-picture"

/**
 * Renderer-to-main request for a look at a page loaded afresh, out of sight, `{ url, layout }`;
 * answers a `DesktopPageLook`. See the viewers' `createLooker`.
 */
export const pageLookChannel = "novadeck:page-look"

/**
 * Renderer-to-main request to make a live page's view act as a phone's, or as itself
 * again, by its web contents id; answers whether it did. See the viewers' `phonePage`.
 */
export const pagePhoneChannel = "novadeck:page-phone"

/**
 * Renderer-to-main request to zoom a live page's view by a factor of the app's own zoom, by
 * its web contents id; answers whether it did. See the viewers' `zoomPage`.
 */
export const pageZoomChannel = "novadeck:page-zoom"

/**
 * Renderer-to-main report of an error the page didn't catch, `{ kind, name, message, stack }`,
 * which the main process logs.
 */
export const uiErrorChannel = "novadeck:ui-error"

/**
 * Renderer-to-main report of how the page's WebGL pool has fared, `RendererPoolReport`,
 * which the main process logs.
 */
export const rendererPoolChannel = "novadeck:renderer-pool"

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
  // The main process is alive and answering; see ./runner/main-watch.ts.
  | { readonly type: "beat" }

/** How often the main process beats to the runner, in ms. */
export const mainBeatMs = 1_000

/** Messages from the runner's utility process to the main process: it is ready to serve. */
export type RunnerReport = { readonly type: "ready" }

/**
 * Main-to-renderer report of what the app's other windows show, `{ elsewhere, voice }`, sent on
 * each change; see main/window/project-windows.ts. A page that starts listening asks for the
 * current one on `projectWindowsRequestChannel`.
 */
export const projectWindowsChannel = "novadeck:project-windows"

/** Renderer-to-main request to be told, on `projectWindowsChannel`, of the current state. */
export const projectWindowsRequestChannel = "novadeck:project-windows-request"

/** Renderer-to-main report of the project the window shows now: its id, or null for none. */
export const projectWindowShowChannel = "novadeck:project-window-show"

/** Renderer-to-main report of whether the person has project windows on, a boolean. */
export const projectWindowsUseChannel = "novadeck:project-windows-use"

/** Renderer-to-main request to open a project in a window of its own: the project's id. */
export const projectWindowOpenChannel = "novadeck:project-window-open"

/** Renderer-to-main request to swap the window's project with the window that shows another. */
export const projectWindowSwapChannel = "novadeck:project-window-swap"

/** Renderer-to-main request to hand a place in a project, `{ projectId, terminalId?, rowId? }`, to its window. */
export const projectWindowHandOffChannel = "novadeck:project-window-hand-off"

/** Main-to-renderer order to go to a place in a project, `{ projectId, terminalId?, rowId? }`. */
export const projectWindowNavigateChannel = "novadeck:project-window-navigate"

/** Main-to-renderer ask to send the page's saves to the runner, with an id to answer with. */
export const projectWindowFlushChannel = "novadeck:project-window-flush"

/** Renderer-to-main answer that the saves asked for landed, with the ask's id. */
export const projectWindowFlushedChannel = "novadeck:project-window-flushed"

/**
 * Given to the page's preload in a window that is not the app's first: the value is `1`;
 * absent in the first window.
 */
export const extraWindowArgumentPrefix = "--novadeck-extra-window="
