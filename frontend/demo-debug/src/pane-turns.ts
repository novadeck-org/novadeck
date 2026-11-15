import type { DemoActionGroup } from "./types"

// Holds the companion panes' turns, so a pane coming into sight keeps its stand-in (its
// icon and name, or its picture) until let go. The page's root carries the attribute items'
// pane-turns.ts reads, which this package can't import.
const attribute = "data-pane-turns-held"

export const togglePaneTurns = (): void => {
  document.documentElement.toggleAttribute(attribute)
}

// Has panes pictured as sketches of their layout, as the demo can't picture its page the
// way the desktop app does, so a pane's picture can stand in for it: the attribute items'
// pane-pictures.ts reads.
const sketched = "data-pane-pictures-sketched"

export const togglePanePictures = (): void => {
  document.documentElement.toggleAttribute(sketched)
}

export const paneTurnsGroup: DemoActionGroup = {
  section: "App",
  title: "Pane turns",
  actions: [
    {
      label: "Hold panes' turns",
      hint: "A companion pane coming into sight (a view switch, a pan, a terminal picked in Focus) shows its icon and name in place of what it holds until pressed again",
      run: togglePaneTurns,
    },
    {
      label: "Sketch panes' pictures",
      hint: "A companion pane in sight a second is pictured as a sketch of its layout, as the desktop app takes a picture of it; with turns held, a pane coming back at the same size shows its sketch in place of its icon and name. Press again to stop",
      run: togglePanePictures,
    },
  ],
}
