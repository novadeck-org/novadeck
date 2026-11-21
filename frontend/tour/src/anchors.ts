import type { TourTarget } from "./steps"

const area = (): Element | null => document.querySelector("[data-workspace-area]")

// A terminal as the workspace draws it, by the `data-terminal` mark every view puts on it.
const terminalElement = (id: string): HTMLElement | null =>
  area()?.querySelector<HTMLElement>(`[data-terminal="${CSS.escape(id)}"]`) ?? null

// Whether an element is drawn at all: one hidden, or in a closed panel, has no box.
const drawn = (element: Element): boolean => element.getClientRects().length > 0

const first = (root: ParentNode | null | undefined, selector: string): HTMLElement[] => {
  const found = [...(root?.querySelectorAll<HTMLElement>(selector) ?? [])].find(drawn)
  return found ? [found] : []
}

// What the targets are read against: the tour's lead, the terminal the coach names, and the
// Inbox row of the team's question waiting now.
export type TargetsOf = {
  readonly lead: string
  readonly terminalId: string
  readonly askingRow: string | null
}

/**
 * The elements a target names now, as drawn: none where the view hides them. `lead` is the
 * tour's lead terminal and `terminal` the one the coach names (the lead's where it names none);
 * `team` every other window of the tour; `newest-message` the latest conversation in the lead's
 * Messages; `asking-row` the Inbox row of the team's question; `answers` the answers of the
 * request sheet open now; `shown` what the lead shows in its side pane.
 */
export const targetElements = (target: TourTarget, where: TargetsOf): HTMLElement[] => {
  const { lead, terminalId, askingRow } = where
  switch (target) {
    case "lead":
    case "terminal": {
      const element = terminalElement(target === "lead" ? lead : terminalId)
      return element && drawn(element) ? [element] : []
    }
    case "team":
      return [...(area()?.querySelectorAll<HTMLElement>("[data-terminal]") ?? [])].filter(
        (element) => element.dataset.terminal !== lead && drawn(element),
      )
    case "newest-message":
      return first(terminalElement(lead), '[data-tour="messages"] .message-row')
    case "asking-row":
      return askingRow
        ? first(document, `[data-tour="inbox-card"][data-inbox-row="${CSS.escape(askingRow)}"]`)
        : []
    case "answers":
      return first(document, '[role="dialog"] [role="group"]:has(button)')
    case "shown":
      return first(terminalElement(lead), '[data-tour="side-pane"]')
  }
}

/** The first of `targets` that names something drawn now, with its elements. */
export const firstTarget = (targets: readonly TourTarget[], where: TargetsOf): HTMLElement[] => {
  for (const target of targets) {
    const elements = targetElements(target, where)
    if (elements.length > 0) return elements
  }
  return []
}
