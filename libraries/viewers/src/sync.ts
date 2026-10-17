// How Markdown texts differ and merge: the changes between two versions, line by line,
// and the merge of two sets of them. Built on CodeMirror's state, so a host loads it
// where it loads the viewer, not beside what it shows eagerly (see ./text.ts).

export { distance, lineChanges, merge } from "./markdown/sync.js"
export type { Range } from "./markdown/ranges.js"
