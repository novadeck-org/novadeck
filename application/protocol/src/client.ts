export { hasCode, RunnerError, type RunnerErrorCode } from "./errors.js"
export {
  connectRunner,
  type AttachedTerminal,
  type CompanionWatchItem,
  type ConnectOptions,
  type Runner,
  type RunnerStatus,
  type TerminalMode,
  type TerminalWatchItem,
  type Transport,
} from "./runner.js"
export { runnerPortMessage, type DesktopBridge, type DesktopHost } from "./bridge.js"
export { desktop } from "./desktop.js"
export { messagePort, websocket } from "./transports.js"
export type { Channel, MessagePortLike } from "./wire.js"
