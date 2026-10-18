// A process with no screen: the pty it runs in and how it ends, its process facts, and on
// Windows its process tree.
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
} from "./pty/pty.js"
