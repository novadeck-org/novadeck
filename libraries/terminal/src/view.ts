// The terminal view in the browser: the registry of screens, the loop that follows a
// terminal's stream into one, and the pastes and queries a screen handles.
export {
  createTerminalViews,
  parkedCap,
  parkMs,
  pasteNoticeMs,
  runnerSize,
} from "./view/screens.js"
export type {
  Hold,
  ShowOptions,
  TerminalFont,
  TerminalViewOptions,
  TerminalViews,
} from "./view/screens.js"
export { followTerminal } from "./view/follow.js"
export type {
  FollowedTerminal,
  FollowOptions,
  Lifecycle,
  Screen,
  ViewEvents,
} from "./view/follow.js"
export { ctrlVHoldMs, ctrlVWaitMs } from "./view/paste.js"
export type { PasteFailure } from "./view/paste.js"
export { pause } from "./view/pause.js"
export { createStore } from "./view/view-state.js"
export type {
  MutableStore,
  Store,
  ViewLink,
  ViewLock,
  ViewPhase,
  ViewState,
} from "./view/view-state.js"
