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

// Whether an element is drawn where the person can see it: one hidden, or in a closed panel, has
// no box; one in a panel kept mounted while another shows is invisible or transparent; and one
// wholly off screen (as a window the camera hasn't reached) can't be pointed at.
const drawn = (element: Element): boolean => {
  if (element.getClientRects().length === 0) return false
  if (
    typeof element.checkVisibility === "function" &&
    !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  )
    return false
  const box = element.getBoundingClientRect()
  return (
    box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight
  )
}

// Whether an element is laid out at all, wherever it is: one out of sight (off screen, behind
// another panel) is, one that doesn't exist or is hidden isn't.
const laidOut = (element: Element): boolean => element.getClientRects().length > 0

// What counts as found: drawn where the person can see it, or only laid out.
type Seen = (element: Element) => boolean

const always: Seen = () => true

const first = (
  root: ParentNode | null | undefined,
  selector: string,
  seen: Seen = drawn,
): HTMLElement[] => {
  const found = [...(root?.querySelectorAll<HTMLElement>(selector) ?? [])].find(seen)
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
const windowOf = (id: string | undefined, seen: Seen = drawn): HTMLElement[] => {
  const element = id === undefined ? null : terminalElement(id)
  return element && seen(element) ? [element] : []
}

// A terminal's companion pane, only while the step's tab is its open, top one: before that
// there is nothing to look at, and nothing is marked.
const paneOf = (
  id: string | undefined,
  shows: PaneTab | null | undefined,
  tab: PaneTab | undefined,
  seen: Seen = drawn,
): HTMLElement[] =>
  id === undefined || tab === undefined || shows !== tab
    ? []
    : first(area(), `[data-companion-of="${CSS.escape(id)}"]`, seen)

/**
 * The elements a target names now, as drawn: none where the view hides them. A role names its
 * terminal's window (`lead`, `modeller`, `builder`) or, with `-pane`, its companion pane;
 * `terminal` the one the coach names (the lead's where it names none); `team` the windows of the
 * lead's teammates, not the terminals it opened for the game's server; `approve` the approval
 * dialog's button to allow; `asking-row` the Inbox row of the question waiting (a teammate's,
 * or the lead's sheet); `answers` the answers of the request sheet open now, on the page it
 * shows; `files` the Files panel.
 */
export const targetElements = (
  target: TourTarget,
  where: TargetsOf,
  seen: Seen = drawn,
): HTMLElement[] => {
  const { roles, terminalId, team, askingRow, open, tab } = where
  switch (target) {
    case "lead":
    case "modeller":
    case "builder":
      return windowOf(roles[target], seen)
    case "lead-pane":
    case "modeller-pane":
    case "builder-pane":
      return paneOf(
        roles[target.slice(0, -"-pane".length) as TourRole],
        open[target.slice(0, -"-pane".length) as TourRole],
        tab,
        seen,
      )
    case "terminal":
      return windowOf(terminalId, seen)
    case "team":
      return team.flatMap((id) => windowOf(id, seen))
    case "approve":
      return first(document, '[role="alertdialog"] button.button.primary', seen)
    case "asking-row":
      return askingRow
        ? first(
            document,
            `[data-tour="inbox-card"][data-inbox-row="${CSS.escape(askingRow)}"]`,
            seen,
          )
        : []
    case "answers": {
      // A sheet of several questions shows one page at a time: its answers there, else (a
      // question of one page) its group of answers.
      const paged = first(
        document,
        '[role="dialog"] [data-page][data-shown] :is([role="radiogroup"], [role="group"])',
        seen,
      )
      return paged.length > 0
        ? paged
        : first(document, '[role="dialog"] [role="group"]:has(button)', seen)
    }
    case "files":
      return first(document, "#files-panel", seen)
    // A rail hidden (as in Zen) still holds its buttons: out of sight, not gone.
    case "inbox-button":
      return first(document, '[data-tour-rail="inbox"]', seen === drawn ? drawn : always)
    case "files-button":
      return first(document, '[data-tour-rail="files"]', seen === drawn ? drawn : always)
  }
}

/**
 * Whether any of `targets` names something that is there but out of the person's sight (off
 * screen, or behind something the person opened): what "Show me" brings back. Something that
 * isn't there yet isn't out of sight.
 */
export const outOfSight = (targets: readonly TourTarget[], where: TargetsOf): boolean =>
  targets.some(
    (target) =>
      targetElements(target, where, laidOut).length > 0 &&
      targetElements(target, where).length === 0,
  )

/**
 * Whether every one of these terminals' windows is drawn wholly inside the workspace: where one
 * isn't (a teammate landed out of sight), the camera has to go out to show it.
 */
export const allInSight = (ids: readonly string[]): boolean => {
  const edge = area()?.getBoundingClientRect()
  if (!edge) return true
  return ids.every((id) => {
    const element = terminalElement(id)
    if (!element) return true
    const box = element.getBoundingClientRect()
    return (
      box.width > 0 &&
      box.left >= edge.left &&
      box.top >= edge.top &&
      box.right <= edge.right &&
      box.bottom <= edge.bottom
    )
  })
}

/**
 * The first of `targets` that names something drawn now, with its elements and its place in the
 * list (0 for the first: a step's subject).
 */
export const firstTarget = (
  targets: readonly TourTarget[],
  where: TargetsOf,
): { readonly elements: HTMLElement[]; readonly index: number } => {
  for (const [index, target] of targets.entries()) {
    const elements = targetElements(target, where)
    if (elements.length > 0) return { elements, index }
  }
  return { elements: [], index: -1 }
}
