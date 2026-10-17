export { hasCode, type RunnerErrorCode } from "./errors.js"
export {
  connectRunner,
  type AttachedTerminal,
  type CompanionWatchItem,
  type ConnectOptions,
  type Runner,
  type TerminalMode,
  type TerminalWatchItem,
} from "./runner.js"
export { runnerPortMessage, type DesktopBridge, type DesktopHost } from "./bridge.js"
export { desktop } from "./desktop.js"
