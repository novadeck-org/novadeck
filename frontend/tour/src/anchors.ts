import type { PaneTab, TourRole, TourSignals } from "./signals"
import type { TourTarget } from "./steps"

const area = (): Element | null => document.querySelector("[data-workspace-area]")

/**
 * A window as a view draws it, by the `data-terminal` mark naming its terminal; not an element
 * that only says it is a terminal's (`data-terminal="true"`, as Agent Chat's error line).
 */
export const windowSelector = '[data-terminal]:not([data-terminal="true"])'

// A terminal as the workspace draws it, by the `data-terminal` mark every view puts on it.
const terminalElement = (id: string): HTMLElement | null =>
  area()?.querySelector<HTMLElement>(`[data-terminal="${CSS.escape(id)}"]`) ?? null

// Whether an element is drawn at all: one hidden, or in a closed panel, has no box.
const drawn = (element: Element): boolean => element.getClientRects().length > 0

const first = (root: ParentNode | null | undefined, selector: string): HTMLElement[] => {
  const found = [...(root?.querySelectorAll<HTMLElement>(selector) ?? [])].find(drawn)
  return found ? [found] : []
}

// What the targets are read against: the terminals of the roles found, the terminal the coach
// names (the lead's where it names none), the teammates' terminals, and the Inbox row of the
// team's question waiting now.
export type TargetsOf = {
  readonly roles: TourSignals["roles"]
  readonly terminalId: string
  readonly team: readonly string[]
  readonly askingRow: string | null
  // What each role's pane shows now.
  readonly open: TourSignals["open"]
  // The tab a pane target is about.
  readonly tab?: PaneTab | undefined
}

// A terminal's window where it is drawn, as a list of what to mark.
const windowOf = (id: string | undefined): HTMLElement[] => {
  const element = id === undefined ? null : terminalElement(id)
  return element && drawn(element) ? [element] : []
}

// A terminal's companion pane, only while the step's tab is its open, top one: before that
// there is nothing to look at, and nothing is marked.
const paneOf = (
  id: string | undefined,
  shows: PaneTab | null | undefined,
  tab: PaneTab | undefined,
): HTMLElement[] =>
  id === undefined || tab === undefined || shows !== tab
    ? []
    : first(area(), `[data-companion-of="${CSS.escape(id)}"]`)

/**
 * The elements a target names now, as drawn: none where the view hides them. A role names its
 * terminal's window (`lead`, `modeller`, `builder`) or, with `-pane`, its companion pane;
 * `terminal` the one the coach names (the lead's where it names none); `team` the windows of the
 * lead's teammates, not the terminals it opened for the game's server; `approve` the approval
 * dialog's button to allow; `asking-row` the Inbox row of the question waiting (a teammate's, or the lead's sheet); `answers` the
 * answers of the request sheet open now; `files` the Files panel.
 */
export const targetElements = (target: TourTarget, where: TargetsOf): HTMLElement[] => {
  const { roles, terminalId, team, askingRow, open, tab } = where
  switch (target) {
    case "lead":
    case "modeller":
    case "builder":
      return windowOf(roles[target])
    case "lead-pane":
    case "modeller-pane":
    case "builder-pane":
      return paneOf(
        roles[target.slice(0, -"-pane".length) as TourRole],
        open[target.slice(0, -"-pane".length) as TourRole],
        tab,
      )
    case "terminal":
      return windowOf(terminalId)
    case "team":
      return team.flatMap(windowOf)
    case "approve":
      return first(document, '[role="alertdialog"] button.button.primary')
    case "asking-row":
      return askingRow
        ? first(document, `[data-tour="inbox-card"][data-inbox-row="${CSS.escape(askingRow)}"]`)
        : []
    case "answers":
      return first(document, '[role="dialog"] [role="group"]:has(button)')
    case "files":
      return first(document, "#files-panel")
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
