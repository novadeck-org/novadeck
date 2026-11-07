import { HandleChip } from "@novadeck/toolkit/HandleChip"

import type { CloseTeamRow } from "../terminals/close-team"
import { markDelay, UnlistedNeed, useGlance } from "./FoldedTeamRows"

// One terminal of the team the dialog lists, in the folded team's row (tabs.css): its
// branch, its phase glyph and name, its plain handle, and what it needs of the person, read
// as its tab reads them so the two never drift apart. With the team folded, a sub-lead's row
// counts those below it and carries the strongest need among them.
const CloseTeamRowView = ({
  row,
  index,
}: {
  row: CloseTeamRow
  index: number
}): React.JSX.Element | null => {
  const read = useGlance(row.id)
  if (!read) return null
  const { tile, glance } = read
  const { phase, need, failed } = glance
  return (
    <li className="team-fold-row close-team-row" data-close-team-row={row.id}>
      <span className="terminal-tab-branch shrink-0">{row.branch}</span>
      <span
        className="team-fold-mark"
        data-phase={phase}
        {...(phase === "done" && failed ? { "data-failed": true } : {})}
        style={markDelay(index)}
      />
      <span className="truncate" {...(tile.state === "sleeping" ? { "data-sleeping": true } : {})}>
        {tile.name}
      </span>
      <HandleChip handle={tile.handle} className="handle-plain" />
      {row.folded.length > 0 && (
        <span className="team-fold-count shrink-0">+{row.folded.length}</span>
      )}
      <span className="team-fold-needs">
        {need && (
          <span className="terminal-tab-need shrink-0" data-need={need}>
            {need === "unblock" ? "!" : "?"}
          </span>
        )}
        {row.folded.map((id) => (
          <UnlistedNeed key={id} id={id} />
        ))}
      </span>
    </li>
  )
}

// The team a lead's close would take: a row each, nested under its own lead. No row for the
// lead itself, which the dialog's bar names.
export const CloseTeamRows = ({ rows }: { rows: readonly CloseTeamRow[] }): React.JSX.Element => (
  <ul className="close-team" aria-label="Its team">
    {rows.map((row, index) => (
      <CloseTeamRowView key={row.id} row={row} index={index} />
    ))}
  </ul>
)
