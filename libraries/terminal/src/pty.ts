// A process with no screen: the pty it runs in and how it ends, its process facts, on
// Windows its process tree, and on Linux the systemd scope it is kept in.
export {
  foregroundProcess,
  foregroundRuns,
  openFiles,
  processGroup,
  processSetting,
  sampleForeground,
  shellInForeground,
  terminalForeground,
  type Foreground,
  type ForegroundProcess,
} from "./pty/foreground.js"
export {
  anyRunning,
  relayMs,
  taskkillTree,
  Trees,
  type Member,
  type RunRelay,
} from "./pty/trees.js"
export {
  spawnPty,
  type Disposable,
  type EndBudget,
  type EndOptions,
  type NativePty,
  type NativeSpawn,
  type ProcessTrees,
  type Pty,
  type PtyExit,
  type PtyOptions,
} from "./pty/pty.js"
export {
  userScopes,
  UserScopes,
  type ExitCause,
  type RunTool,
  type Scope,
  type Scopes,
} from "./pty/scopes.js"
