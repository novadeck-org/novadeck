import { EditorView } from "@codemirror/view"

// What the markdown viewer changes of CodeMirror's own look. CodeMirror mounts its styles
// outside every cascade layer, where no layered stylesheet can override them, so these go
// in as an editor theme, which CodeMirror orders after its base theme, and read the
// viewer's tokens (see ../markdown.css, which draws everything else).
export const theme = EditorView.theme({
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit" },
  ".cm-content": {
    caretColor: "var(--md-fg, currentColor)",
    padding: "14px 44px 64px 20px",
  },
  ".cm-line": { padding: "0" },
  ".cm-selectionBackground": {
    background: "var(--md-selection-bg, color-mix(in srgb, currentColor 18%, transparent))",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "var(--md-selection-bg, color-mix(in srgb, currentColor 18%, transparent))",
  },
  ".cm-cursor": { borderLeftColor: "var(--md-fg, currentColor)" },
  // The base theme's gutter is grey on light grey, in colours of its own. A host's gutters
  // sit flat on the page.
  ".cm-gutters": {
    border: "0",
    background: "transparent",
    color: "var(--md-muted-fg, color-mix(in srgb, currentColor 60%, transparent))",
  },
  ".cm-activeLineGutter": { background: "transparent" },
  // Lines' own padding.
  ".cm-md-h2": { paddingTop: "18px" },
  ".cm-md-h3": { paddingTop: "10px" },
  ".cm-md-item": { paddingLeft: "22px" },
  ".cm-md-item-task": { paddingLeft: "44px" },
  ".cm-md-quote": { paddingLeft: "16px" },
  ".cm-md-codeblock": { padding: "0 14px" },
  "@container md-viewer (max-width: 560px)": {
    ".cm-content": { padding: "10px 20px 40px 20px" },
  },
})
