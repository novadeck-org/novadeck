// The terminal view in the browser: the registry of screens, one per terminal, that follows
// its stream and takes its pastes. It silences the queries the host answers, and answers only
// the colour ones itself.
export { createTerminalViews, parkedCap, parkMs } from "./view/screens.js"
export type { Hold, TerminalViewOptions, TerminalViews } from "./view/screens.js"
export type { PasteFailure } from "./view/paste.js"
export type { ViewPhase } from "./view/view-state.js"
