import { descendantsOf, teamOf } from "@novadeck/core/derivations"
import { isWindow } from "@novadeck/core/roster"
import { terminalGlance } from "@novadeck/core/terminals/ending"
import type { TerminalMetadata } from "@novadeck/core/types"
import { NeedMark } from "@novadeck/toolkit/NeedMark"
import {
  listedFoldRows,
  TeamFoldMore,
  TeamFoldRow,
  TeamFoldRows,
} from "@novadeck/toolkit/TeamFoldRows"

import { unreadEnd } from "../terminals/unread-state"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentContext, currentState, currentTarget, sameItems, sameTarget } from "./selectors"
import { toggleTeamFold } from "./team-fold"
import { useTerminalMarks } from "./useTerminalMarks"

// A teammate as its tab reads it: the terminal and its phase, need and failure, from the
// same marks and unread end the tab uses (terminalGlance), so rows and tabs never drift
// apart. Undefined for what isn't a terminal of the session.
export const useGlance = (
  id: string,
): { tile: TerminalMetadata; glance: ReturnType<typeof terminalGlance> } | undefined => {
  const { landing } = useWorkspaceServices()
  const target = useWorkspaceState(currentTarget, sameTarget)
  const context = useWorkspaceState(currentContext)
  const tile = useWorkspaceState((workspace) =>
    currentState(workspace).roster.terminals.find((terminal) => terminal.id === id),
  )
  const marks = useTerminalMarks(landing.inbox, { ...target, terminalId: id })
  const unread = useUiState((state) => unreadEnd(state.unread, context, id))
  if (!tile || isWindow(tile)) return undefined
  return { tile, glance: terminalGlance(tile, marks, unread) }
}

// One folded teammate's row, read as its own tab reads it (terminalGlance), so the two never
// drift apart: a click goes to it, as a click on its tab would.
const FoldedRow = ({
  id,
  index,
  last,
}: {
  id: string
  index: number
  last: boolean
}): React.JSX.Element | null => {
  const { commands } = useWorkspaceServices()
  const selected = useWorkspaceState((workspace) => currentState(workspace).selected === id)
  // A teammate that leads its own team: those it folds away with it, at any depth.
  const below = useWorkspaceState((workspace) => descendantsOf(workspace, id), sameItems)
  const view = useWorkspaceState((workspace) => currentState(workspace).view)
  const read = useGlance(id)
  if (!read) return null
  const { tile, glance } = read
  const { phase, need, failed } = glance
  return (
    <TeamFoldRow
      id={id}
      index={index}
      last={last}
      phase={phase}
      failed={failed}
      name={tile.name}
      sleeping={tile.state === "sleeping"}
      selected={selected}
      below={below.length}
      // What it, or any terminal it folds away with it, needs of the person: the strongest.
      needs={
        <>
          {need && <NeedMark need={need} />}
          {below.map((each) => (
            <UnlistedNeed key={each} id={each} />
          ))}
        </>
      }
      // The window's click that sends the keys to the selected terminal (useKeyboard) doesn't
      // hear the row's, so the row sends them to its teammate as that does.
      onOpen={() => {
        commands.select(id)
        commands.setKeyboardFocus({ id, view })
      }}
    />
  )
}

// What an unlisted teammate needs of the person, on the row that counts it: its `!` or `?`,
// or nothing.
export const UnlistedNeed = ({ id }: { id: string }): React.JSX.Element | null => {
  const need = useGlance(id)?.glance.need
  return need ? <NeedMark need={need} /> : null
}

// A folded lead's teammates, under its tab's line (TeamFoldRows): a row each, so nothing a
// teammate does or needs of the person folds away with its tab. Past four, the last row counts
// the rest, with what any of them needs of the person, and a click on it shows the team again.
// The switcher and the arrow keys reach every teammate.
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
  // Every terminal the fold hides, at any depth, for what the unlisted ones need, and those
  // under each teammate, whose needs show on its row.
  const folded = useWorkspaceState((workspace) => descendantsOf(workspace, lead), sameItems)
  const trees = useWorkspaceState(
    (workspace) => workers.map((id) => descendantsOf(workspace, id).join(" ")),
    sameItems,
  )
  if (!workers.length) return null
  const listed = workers.length > listedFoldRows ? workers.slice(0, listedFoldRows - 1) : workers
  const listedTrees = trees.slice(0, listed.length).map((tree) => tree.split(" "))
  const rest = workers.length - listed.length
  // A terminal under a listed row shows its need there.
  const listedBelow = (id: string) => listedTrees.some((tree) => tree.includes(id))
  return (
    <TeamFoldRows entering={entering}>
      {listed.map((id, index) => (
        <FoldedRow key={id} id={id} index={index} last={!rest && index === listed.length - 1} />
      ))}
      {rest > 0 && (
        <TeamFoldMore
          count={rest}
          needs={folded
            .filter((id) => !listed.includes(id) && !listedBelow(id))
            .map((id) => (
              <UnlistedNeed key={id} id={id} />
            ))}
          onUnfold={() => toggleTeamFold(ui, context, lead)}
        />
      )}
    </TeamFoldRows>
  )
}
const noWorkers: readonly string[] = []
