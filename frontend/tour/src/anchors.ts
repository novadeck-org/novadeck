import type { TourAnchor } from "./steps"

// A terminal as the workspace draws it, by the `data-terminal` mark every view puts on it.
const terminalElement = (id: string): HTMLElement | null =>
  document
    .querySelector("[data-workspace-area]")
    ?.querySelector<HTMLElement>(`[data-terminal="${CSS.escape(id)}"]`) ?? null

// Where each of the tour's anchors is in the page: its `data-tour` mark, then a stable hook of
// the element's own where the mark is drawn by a shared part (a sidebar panel, a rail toggle).
const selectors: Readonly<Record<Exclude<TourAnchor, "terminal">, readonly string[]>> = {
  tabs: ['[data-tour="tabs"]'],
  terminals: ['[data-tour="terminals"]', "#terminals-panel"],
  messages: ['[data-tour="messages"]'],
  inbox: ['[data-tour="inbox"]', "#inbox-toggle", "#mobile-inbox-toggle"],
  "inbox-card": ['[data-tour="inbox-card"]'],
  views: ['[data-tour="views"]'],
  "side-pane": ['[data-tour="side-pane"]'],
}

// Whether an element is drawn at all: one hidden, or in a closed panel, has no box.
const drawn = (element: Element): boolean => element.getClientRects().length > 0

/**
 * The element an anchor points at now, the first drawn of its marks; within the lead's own
 * terminal where it has one there (its side pane, its Messages), else anywhere. Null where none
 * is drawn, as in a view that hides it: the coach then floats in a corner.
 */
export const anchorElement = (anchor: TourAnchor, terminalId: string): HTMLElement | null => {
  const terminal = terminalElement(terminalId)
  if (anchor === "terminal") return terminal && drawn(terminal) ? terminal : null
  for (const selector of selectors[anchor]) {
    const within = terminal?.querySelector<HTMLElement>(selector)
    if (within && drawn(within)) return within
    const found = [...document.querySelectorAll<HTMLElement>(selector)].find(drawn)
    if (found) return found
  }
  return null
}
