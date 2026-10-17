// Shell integration: the directories a shell reports, Windows' registry PATH, the locale a
// shell starts in and the length of its line.
export { afterKeys, emptyLine, type Line } from "./shell/line.js"
export { withLocale } from "./shell/locale.js"
export { osc7Directory, osc9Directory } from "./shell/osc.js"
export { forgetPath, pathKey, readRegistry, refreshPath } from "./shell/windows-path.js"
