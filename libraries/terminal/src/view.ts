// The terminal view in the browser: the registry of screens, one per terminal, that follows
// its stream, takes its pastes and answers its queries.
export { createTerminalViews, parkedCap, parkMs } from "./view/screens.js"
export type { Hold, TerminalViewOptions, TerminalViews } from "./view/screens.js"
export { pause } from "./view/follow.js"
export type { PasteFailure } from "./view/paste.js"
export type { ViewPhase } from "./view/view-state.js"
