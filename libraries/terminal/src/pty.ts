// A process with no screen: the pty it runs in and how it ends, its process facts, on
// Windows its process tree, and on Linux the systemd scope it is kept in, on macOS what its
// processes' environment names.
export {
  foregroundProcess,
  hasChildProcess,
  tableForeground,
  hasTerminalChild,
  processTable,
  type TableRow,
  hasJobUnder,
  foregroundRuns,
  openFiles,
  processGroup,
  processSetting,
  sampleForeground,
  shellInForeground,
  terminalForeground,
  type Foreground,
} from "./pty/foreground.js"
export { sameProcess, type ApartProcess } from "./pty/apart.js"
export {
  endFollowed,
  placement,
  processKey,
  processListing,
  withBelow,
  type Followed,
  type Listed,
  type Listing,
  type Placement,
} from "./pty/descendants.js"
export { processesUnder, startResolutionMs, type Spawn } from "./pty/spawned.js"
export { anyRunning, chainTo, relayMs, Trees, type Member } from "./pty/trees.js"
export type { ProcessTrees, Pty, PtyOptions } from "./pty/pty.js"
export { activeCpuWeight, setScopeWeight, terminalCpuWeight, userScopes } from "./pty/scopes.js"
export { taggedScopes } from "./pty/tagged.js"
export type { Activity } from "./pty/boost.js"
export { priorityFor, terminalPriorities, terminalPriority, type Priority } from "./pty/priority.js"
