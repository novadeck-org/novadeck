// The marks that change the direction text reads in, as a browser draws it: the
// bidirectional marks, embeddings, overrides and isolates (protocol's `directionMark`).
const directions = /[؜‎‏‪-‮⁦-⁩]/gu

// Text with each mark that changes its direction shown as its code point, as `⟨U+202E⟩`.
// The chat draws text in the browser's bidirectional order, while the terminal shows it in
// the order it was written, so a command an override hides would read one way on a card the
// person approves it from, and another where it runs.
export const shownControls = (text: string): string =>
  text.replace(
    directions,
    (mark) => `⟨U+${mark.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`,
  )
