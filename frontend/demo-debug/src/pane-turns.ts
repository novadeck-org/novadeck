import type { DemoActionGroup } from "./types"

// Holds the companion panes' and chats' turns, so a pane or chat coming into sight keeps its
// stand-in (its icon and name, its terminal's name, or its picture) until let go. The page's root carries the attribute items'
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
      hint: "A companion pane coming into sight (a view switch, a pan, a terminal picked in Focus) shows its icon and name in place of what it holds, and a chat its terminal's name, until pressed again",
      run: togglePaneTurns,
    },
    {
      label: "Sketch panes' pictures",
      hint: "A companion pane or chat in sight a second is pictured as a sketch of its layout, as the desktop app takes a picture of it; with turns held, a pane coming back at the same size, or a chat its view shows again with nothing new, shows its sketch in place of its name. Press again to stop",
      run: togglePanePictures,
    },
  ],
}
