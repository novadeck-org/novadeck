import { EditorView } from "@codemirror/view"

// What the plan editor changes of CodeMirror's own look. CodeMirror mounts its styles
// outside every cascade layer, where no layered stylesheet can override them, so these
// go in as an editor theme, which CodeMirror orders after its base theme, and read the
// prose recipe's tokens (see ../prose.css, which draws everything else of the plan).
export const editorTheme = EditorView.theme({
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit" },
  ".cm-content": {
    caretColor: "var(--prose-fg, var(--color-ink))",
    padding: "14px 44px 64px 20px",
  },
  ".cm-line": { padding: "0" },
  ".cm-selectionBackground": { background: "var(--prose-selection-bg, var(--color-selection))" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "var(--prose-selection-bg, var(--color-selection))",
  },
  ".cm-cursor": { borderLeftColor: "var(--prose-fg, var(--color-ink))" },
  // The base theme's gutter is grey on light grey, in colours of its own.
  ".cm-gutters": {
    border: "0",
    background: "transparent",
    color: "var(--prose-muted-fg, var(--color-muted))",
  },
  ".cm-activeLineGutter": { background: "transparent" },
  // Lines' own padding, in this order: a later one wins over an earlier one.
  ".cm-plan-h2": { paddingTop: "18px" },
  ".cm-plan-h3": { paddingTop: "10px" },
  ".cm-plan-item": { paddingLeft: "22px" },
  ".cm-plan-item-task": { paddingLeft: "44px" },
  ".cm-plan-quote": { paddingLeft: "16px" },
  ".cm-plan-codeblock": { padding: "0 14px" },
  ".cm-plan-note-line": { padding: "14px 12px 8px calc(var(--_note-indent) + 10px)" },
  "@container plan-reader (max-width: 560px)": {
    ".cm-content": { padding: "10px 20px 40px 20px" },
  },
})
