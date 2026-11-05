// The controls that reorder the text around them as a browser draws it: the bidirectional
// embeddings and overrides (U+202A-U+202E) and isolates (U+2066-U+2069), the ones a command
// can hide behind. Not the plain marks (U+200E, U+200F, U+061C), which right-to-left text
// holds in earnest and which reorder no letters.
const reordering = new RegExp("[\\u202a-\\u202e\\u2066-\\u2069]", "gu")

// Text with each control that reorders it shown as its code point, as `⟨U+202E⟩`. The chat
// draws text in the browser's bidirectional order, while the terminal shows it in the order
// it was written, so a command an override hides would read one way on a card the person
// approves it from, and another where it runs.
export const shownControls = (text: string): string =>
  text.replace(reordering, (control) => `⟨U+${control.codePointAt(0)!.toString(16).toUpperCase()}⟩`)
