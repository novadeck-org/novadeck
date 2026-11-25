import type { MouseEvent, ReactNode } from "react"

import { glyphDelay, PhaseGlyph, type GlyphPhase } from "./PhaseGlyph"

// A member's row of a sidebar list in its lead's fold (team-rows.css): folded away leaves the
// layout, and unrolls from no height as its team comes back. As utilities, since a row's own
// `flex` and least height are (the item recipe's), which team-rows.css's layer can't outrank.
export const teamFoldRowClasses =
  "data-[team-fold=away]:hidden data-[team-fold=away]:min-h-0 data-[team-fold=unfolding]:starting:min-h-0"

// How many members a folded lead lists one by one; past it, the last row counts the rest, as a
// tab's subagent rows do.
export const listedFoldRows = 4

// A click on a row inside the lead's select button is the row's own, so the lead's select and
// whatever listens on the window for it (as the Terminals list's sending keys to the selected
// terminal) don't hear it.
const own = (act: () => void) => (event: MouseEvent) => {
  event.stopPropagation()
  event.preventDefault()
  act()
}

// One folded member's row: its branch, its phase glyph and name, how many fold away with it, and
// what it, or any of those, needs of the person (`needs`: need marks, the strongest of which
// shows). A click goes to it. The list reads all of it as the member's own row reads it, so the
// two never drift apart.
export const TeamFoldRow = ({
  id,
  index,
  last,
  phase,
  failed = false,
  name,
  sleeping = false,
  selected = false,
  below = 0,
  needs,
  onOpen,
}: {
  readonly id: string
  readonly index: number
  readonly last: boolean
  readonly phase: GlyphPhase
  readonly failed?: boolean
  readonly name: string
  // Its name dims, as an asleep member's own row's does.
  readonly sleeping?: boolean
  readonly selected?: boolean
  // A member that leads its own team: those it folds away with it, at any depth.
  readonly below?: number
  readonly needs?: ReactNode
  readonly onOpen: () => void
}): React.JSX.Element => (
  <span
    className="team-fold-row"
    data-team-fold-row={id}
    {...(selected ? { "data-selected": true } : {})}
    onClick={own(onOpen)}
  >
    <span className="team-fold-branch shrink-0">{last ? "└" : "├"}</span>
    {/* Each spinner starts at its own frame, so rows side by side don't tick as one. */}
    <PhaseGlyph
      phase={phase}
      failed={failed}
      className="team-fold-mark"
      style={glyphDelay(index)}
    />
    <span className="truncate" {...(sleeping ? { "data-sleeping": true } : {})}>
      {name}
    </span>
    {below > 0 && <span className="team-fold-count shrink-0">+{below}</span>}
    <span className="team-fold-needs">{needs}</span>
  </span>
)

// The last row past `listedFoldRows`, counting the members not listed, with what any of them
// needs of the person; a click on it shows the team again.
export const TeamFoldMore = ({
  count,
  needs,
  onUnfold,
}: {
  readonly count: number
  readonly needs?: ReactNode
  readonly onUnfold: () => void
}): React.JSX.Element => (
  <span className="team-fold-row team-fold-more" data-team-fold-more onClick={own(onUnfold)}>
    <span className="team-fold-branch shrink-0">└</span>
    <PhaseGlyph phase="idle" className="team-fold-mark" />
    <span className="truncate">+{count} more</span>
    <span className="team-fold-needs">{needs}</span>
  </span>
)

// A folded lead's members, under its line (its row's `below`): a row each, so the lead's row
// grows to hold the team it folded in and nothing a member does or needs of the person folds
// away with its row. Drawn only: the lead's description says the fold in words, and the list's
// own ways (its keys, a switcher) reach every member. The rows grow in only as the person folds
// the team (`entering`), not each time they mount.
export const TeamFoldRows = ({
  entering,
  children,
}: {
  readonly entering: boolean
  readonly children: ReactNode
}): React.JSX.Element => (
  <span
    aria-hidden
    className="team-fold-rows -mt-1 grid min-w-0"
    data-team-fold-rows
    {...(entering ? { "data-entering": true } : {})}
    ref={keepPress}
  >
    <span className="team-fold-rows-fold min-h-0 overflow-hidden">
      <span className="flex min-w-0 flex-col pt-1 text-caption leading-[18px]">{children}</span>
    </span>
  </span>
)

// A press on the rows would start dragging the lead, whose sensor listens on its select button
// natively, below React's root, and would focus that button, so focus wouldn't follow the row's
// member: the rows keep the press to themselves, natively, and take no focus.
const stop = (event: Event) => {
  event.stopPropagation()
  event.preventDefault()
}
const keepPress = (node: HTMLElement | null) => {
  if (!node) return
  node.addEventListener("pointerdown", stop)
  return () => node.removeEventListener("pointerdown", stop)
}
