import { teamOf } from "@novadeck/core/derivations"
import { isWindow } from "@novadeck/core/roster"
import { terminalGlance } from "@novadeck/core/terminals/ending"

import { unreadEnd } from "../terminals/unread-state"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentContext, currentState, currentTarget, sameItems, sameTarget } from "./selectors"
import { toggleTeamFold } from "./team-fold"
import { useTerminalMarks } from "./useTerminalMarks"

// How many teammates a folded lead marks one by one before it counts the rest, as a tab's
// line does its subagents.
const shownMarks = 4

// Each mark's spinner starts at its own frame, so marks side by side don't tick as one.
const markDelay = (index: number) => ({ animationDelay: `-${((index + 1) * 260) % 800}ms` })

// One folded teammate's mark: its phase glyph, or what it needs of the person in its place,
// read as its own tab reads it (terminalGlance), so the two never drift apart.
const FoldedMark = ({ id, index }: { id: string; index: number }): React.JSX.Element | null => {
  const { backend } = useWorkspaceServices()
  const target = useWorkspaceState(currentTarget, sameTarget)
  const context = useWorkspaceState(currentContext)
  const tile = useWorkspaceState((workspace) =>
    currentState(workspace).roster.terminals.find((terminal) => terminal.id === id),
  )
  const marks = useTerminalMarks(backend.inbox, { ...target, terminalId: id })
  const unread = useUiState((state) => unreadEnd(state.unread, context, id))
  if (!tile || isWindow(tile)) return null
  const { phase, need, failed } = terminalGlance(tile, marks, unread)
  return (
    <span
      className="team-fold-mark"
      data-phase={phase}
      {...(need ? { "data-need": need } : {})}
      {...(phase === "done" && failed ? { "data-failed": true } : {})}
      style={markDelay(index)}
    />
  )
}

// A folded lead's teammates, after its name: a mark each, past four the rest counted. They
// stand for the tabs folded away, so what a teammate needs of the person still shows, and a
// click on them shows the teammates again. Drawn only: the lead's description says the
// fold in words, and its menu is the keyboard's way back.
export const FoldedTeamMarks = ({ lead }: { lead: string }): React.JSX.Element | null => {
  const { ui } = useWorkspaceServices()
  const context = useWorkspaceState(currentContext)
  const workers = useWorkspaceState((workspace) => {
    const team = teamOf(workspace, lead)
    return team?.lead === lead ? team.workers : noWorkers
  }, sameItems)
  if (!workers.length) return null
  const shown = workers.slice(0, shownMarks)
  const rest = workers.length - shown.length
  return (
    <span
      aria-hidden
      className="team-fold-marks"
      data-team-fold-marks
      // Pressing here would start dragging the lead, whose sensor listens on its select button
      // natively, below React's root: the marks keep the press to themselves natively too. A
      // click is theirs alone as well, so it doesn't select the lead.
      ref={keepPress}
      onClick={(event) => {
        event.stopPropagation()
        event.preventDefault()
        toggleTeamFold(ui, context, lead)
      }}
    >
      {shown.map((id, index) => (
        <FoldedMark key={id} id={id} index={index} />
      ))}
      {rest > 0 && <span className="team-fold-more">+{rest}</span>}
    </span>
  )
}
const noWorkers: readonly string[] = []

const stop = (event: Event) => event.stopPropagation()
const keepPress = (node: HTMLElement | null) => {
  if (!node) return
  node.addEventListener("pointerdown", stop)
  return () => node.removeEventListener("pointerdown", stop)
}
