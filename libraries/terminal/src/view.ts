// The terminal view in the browser: the registry of screens, one per terminal, that follows
// its stream and takes its pastes. It silences the queries the host answers, and answers only
// the colour ones itself.
export { createTerminalScreens, parkedCap, parkMs } from "./view/screens.js"
export type { Hold, ShowOptions, TerminalScreens, TerminalScreensOptions } from "./view/screens.js"
export { clipboardImages, pastedFiles, pastedText, uploadName } from "./view/paste.js"
export type { PasteFailure } from "./view/paste.js"
export type { ViewPhase } from "./view/view-state.js"
export { classifyInput, takeIdleMs } from "./view/takeover.js"
export type { InputClass } from "./view/takeover.js"
export type { ControlStrip } from "./view/view-state.js"
