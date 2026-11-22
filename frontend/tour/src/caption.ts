// When a step's caption box may be on screen: only once that step's own mark has resolved to an
// element (a step that marks nothing counts as resolved at once), and from then on for the step.
// Never because an earlier step's mark showed, and never on a timeout: a step whose subject
// doesn't exist yet (an image still to be drawn) has no box on screen at all.
export const hasPointed = (before: boolean, marks: boolean, subject: boolean): boolean =>
  before || !marks || subject

// How long the box holds back once the step has pointed, so the mark comes first.
export const captionDelayMs = 1_000
