import { descendantsOf, teamOf } from "@novadeck/core/derivations"
import { isWindow } from "@novadeck/core/roster"
import { terminalGlance } from "@novadeck/core/terminals/ending"

import { unreadEnd } from "../terminals/unread-state"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentContext, currentState, currentTarget, sameItems, sameTarget } from "./selectors"
import { toggleTeamFold } from "./team-fold"
import { useTerminalMarks } from "./useTerminalMarks"

// How many teammates a folded lead lists one by one; past it, the last row counts the rest,
// as a tab's subagent rows do.
const listedRows = 4

// Each spinner starts at its own frame, so rows side by side don't tick as one.
const markDelay = (index: number) => ({ animationDelay: `-${((index + 1) * 260) % 800}ms` })

// One folded teammate's row: its branch, its phase glyph and name, and what it needs of the
// person after the name, read as its own tab reads them (terminalGlance), so the two never
// drift apart. A click goes to it.
const FoldedRow = ({
  id,
  index,
  last,
}: {
  id: string
  index: number
  last: boolean
}): React.JSX.Element | null => {
  const { backend, commands } = useWorkspaceServices()
  const target = useWorkspaceState(currentTarget, sameTarget)
  const context = useWorkspaceState(currentContext)
  const tile = useWorkspaceState((workspace) =>
    currentState(workspace).roster.terminals.find((terminal) => terminal.id === id),
  )
  const selected = useWorkspaceState((workspace) => currentState(workspace).selected === id)
  // A teammate that leads its own team: how many it folds away with it, at any depth.
  const leads = useWorkspaceState((workspace) => descendantsOf(workspace, id).length)
  const view = useWorkspaceState((workspace) => currentState(workspace).view)
  const marks = useTerminalMarks(backend.inbox, { ...target, terminalId: id })
  const unread = useUiState((state) => unreadEnd(state.unread, context, id))
  if (!tile || isWindow(tile)) return null
  const { phase, need, failed } = terminalGlance(tile, marks, unread)
  return (
    <span
      className="team-fold-row"
      data-team-fold-row={id}
      {...(selected ? { "data-selected": true } : {})}
      onClick={(event) => {
        // Inside the lead's select button: the row's click is its own, so the window's click
        // that sends the keys to the selected terminal (useKeyboard) doesn't hear it either,
        // and the row sends them to its teammate as that does.
        event.stopPropagation()
        event.preventDefault()
        commands.select(id)
        commands.setKeyboardFocus({ id, view })
      }}
    >
      <span className="terminal-tab-branch shrink-0">{last ? "└" : "├"}</span>
      <span
        className="team-fold-mark"
        data-phase={phase}
        {...(phase === "done" && failed ? { "data-failed": true } : {})}
        style={markDelay(index)}
      />
      <span className="truncate">{tile.name}</span>
      {leads > 0 && <span className="team-fold-count shrink-0">+{leads}</span>}
      {need && (
        <span className="terminal-tab-need shrink-0" data-need={need}>
          {need === "unblock" ? "!" : "?"}
        </span>
      )}
    </span>
  )
}

// What an unlisted teammate needs of the person, on the row that counts it: its `!` or `?`,
// or nothing.
const UnlistedNeed = ({ id }: { id: string }): React.JSX.Element | null => {
  const { backend } = useWorkspaceServices()
  const target = useWorkspaceState(currentTarget, sameTarget)
  const context = useWorkspaceState(currentContext)
  const tile = useWorkspaceState((workspace) =>
    currentState(workspace).roster.terminals.find((terminal) => terminal.id === id),
  )
  const marks = useTerminalMarks(backend.inbox, { ...target, terminalId: id })
  const unread = useUiState((state) => unreadEnd(state.unread, context, id))
  if (!tile || isWindow(tile)) return null
  const { need } = terminalGlance(tile, marks, unread)
  return need ? (
    <span className="terminal-tab-need shrink-0" data-need={need}>
      {need === "unblock" ? "!" : "?"}
    </span>
  ) : null
}

// A folded lead's teammates, under its line: a row each, so the tab grows to hold the team it
// folded in and nothing a teammate does or needs of the person folds away with its tab. A click
// on a row goes to that teammate. Past four, the last row counts the rest, with what any of
// them needs of the person, and a click on it shows the team again. Drawn only: the lead's
// description says the fold in words, and the switcher and the arrow keys reach every teammate.
export const FoldedTeamRows = ({ lead }: { lead: string }): React.JSX.Element | null => {
  const { ui } = useWorkspaceServices()
  const context = useWorkspaceState(currentContext)
  // The rows grow in only as the person folds the team, not each time they mount.
  const entering = useUiState(
    (state) => state.folding?.context === context && state.folding.lead === lead,
  )
  const workers = useWorkspaceState((workspace) => {
    const team = teamOf(workspace, lead)
    return team?.lead === lead ? team.workers : noWorkers
  }, sameItems)
  if (!workers.length) return null
  const listed = workers.length > listedRows ? workers.slice(0, listedRows - 1) : workers
  const rest = workers.length - listed.length
  return (
    <span
      aria-hidden
      className="team-fold-rows -mt-1 grid min-w-0"
      data-team-fold-rows
      {...(entering ? { "data-entering": true } : {})}
      ref={keepPress}
    >
      <span className="team-fold-rows-fold min-h-0 overflow-hidden">
        <span className="flex min-w-0 flex-col pt-1 text-caption leading-[18px]">
          {listed.map((id, index) => (
            <FoldedRow key={id} id={id} index={index} last={!rest && index === listed.length - 1} />
          ))}
          {rest > 0 && (
            <span
              className="team-fold-row team-fold-more"
              data-team-fold-more
              onClick={(event) => {
                event.stopPropagation()
                event.preventDefault()
                toggleTeamFold(ui, context, lead)
              }}
            >
              <span className="terminal-tab-branch shrink-0">└</span>
              <span className="team-fold-mark" />
              <span className="truncate">+{rest} more</span>
              {workers.slice(listed.length).map((id) => (
                <UnlistedNeed key={id} id={id} />
              ))}
            </span>
          )}
        </span>
      </span>
    </span>
  )
}
const noWorkers: readonly string[] = []

// A press on the rows would start dragging the lead, whose sensor listens on its select
// button natively, below React's root, and would focus that button, so focus wouldn't follow
// the row's teammate: the rows keep the press to themselves, natively, and take no focus.
const stop = (event: Event) => {
  event.stopPropagation()
  event.preventDefault()
}
const keepPress = (node: HTMLElement | null) => {
  if (!node) return
  node.addEventListener("pointerdown", stop)
  return () => node.removeEventListener("pointerdown", stop)
}
