import { descendantsOf, teamOf } from "@novadeck/core/derivations"
import type { Workspace } from "@novadeck/core/types"

// How many rows the dialog lists one by one; past it, each sub-team folds into its lead's
// row as a count, as a folded lead's rows count what a teammate folds away.
export const listedRows = 8

export type CloseTeamRow = {
  readonly id: string
  // Its place in the tree: the lines of the leads above it carried down (`│` while they have
  // rows still to come), then its own `├` or `└`.
  readonly branch: string
  // The terminals its row stands for when its team is folded into it, at any depth.
  readonly folded: readonly string[]
}

// What closing a lead with its team takes: every terminal it leads, nested under its own lead.
export type CloseTeamTree = {
  readonly rows: readonly CloseTeamRow[]
  // The lead and everyone below it.
  readonly total: number
}

export const sameCloseTeamTree = (a: CloseTeamTree, b: CloseTeamTree): boolean =>
  a.total === b.total &&
  a.rows.length === b.rows.length &&
  a.rows.every(
    (row, index) =>
      row.id === b.rows[index]!.id &&
      row.branch === b.rows[index]!.branch &&
      row.folded.join(" ") === b.rows[index]!.folded.join(" "),
  )

export const closeTeamTree = (workspace: Workspace, lead: string): CloseTeamTree => {
  const below = descendantsOf(workspace, lead)
  const folds = below.length > listedRows
  const seen = new Set([lead])
  const list = (of: string, carried: string): readonly CloseTeamRow[] => {
    const team = teamOf(workspace, of)
    const workers = (team?.lead === of ? team.workers : []).filter((id) => !seen.has(id))
    for (const id of workers) seen.add(id)
    return workers.flatMap((id, index) => {
      const last = index === workers.length - 1
      const branch = `${carried}${last ? "└" : "├"}`
      if (folds) return [{ id, branch, folded: descendantsOf(workspace, id) }]
      return [{ id, branch, folded: [] }, ...list(id, `${carried}${last ? "  " : "│ "}`)]
    })
  }
  // With the team folded, only the lead's direct teammates are listed: each row counts what
  // is below it.
  return { rows: list(lead, ""), total: below.length + 1 }
}
