import type { DemoActionGroup } from "./types"

// Holds the companion panes' turns, so a pane coming into sight keeps its stand-in (its
// icon and name) until let go. The page's root carries the attribute items' pane-turns.ts
// reads, which this package can't import.
const attribute = "data-pane-turns-held"

export const togglePaneTurns = (): void => {
  document.documentElement.toggleAttribute(attribute)
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
  ],
}
