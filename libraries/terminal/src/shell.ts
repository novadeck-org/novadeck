// Shell integration: the files and launch that make a shell report its directory, keep a
// folder first on PATH and run a startup command; the directories a shell reports,
// Windows' registry PATH, the locale a shell starts in and the length of its line.
export {
  shellLaunch,
  startsCommands,
  type ShellLaunch,
  type ShellLaunchOptions,
} from "./shell/launch.js"
export { afterKeys, emptyLine, type Line } from "./shell/line.js"
export { withLocale } from "./shell/locale.js"
export { osc7Directory, osc9Directory } from "./shell/osc.js"
export { cmdQuote, fishQuote, psQuote, shQuote } from "./shell/quote.js"
export {
  shellScriptPaths,
  shellScripts,
  type ShellFile,
  type ShellScriptPaths,
} from "./shell/scripts.js"
export { forgetPath, pathKey, readRegistry, refreshPath } from "./shell/windows-path.js"
