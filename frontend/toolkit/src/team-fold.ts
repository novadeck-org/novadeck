// Teams folded into their leads in a sidebar list (team-rows.css): folding is for someone who
// only follows a lead, and hides its members' rows from the list. The Terminals list keeps its
// folds by session (ui's terminals/team-fold.ts); any list can keep its own the same way.

// Each context's folded leads (for the Terminals list, a session's: `currentContext`), the most
// recently changed context last.
export type FoldedTeams = Readonly<Record<string, readonly string[]>>

export const isFolded = (folded: FoldedTeams, context: string, lead: string): boolean =>
  folded[context]?.includes(lead) ?? false

// Whether a member's row folds away: one under a folded lead, at any depth (a fold covers the
// teams its teammates lead too), unless the person is on it, or on one below it, which shows in
// its place with the leads between (as when an Inbox entry took them there) and folds away again
// once they move on. `above` is the leads above it, nearest first; `kept` says the person is on
// it or below it.
export const foldsAway = (
  folded: FoldedTeams,
  context: string,
  above: readonly string[],
  kept: boolean,
): boolean => !kept && above.some((lead) => isFolded(folded, context, lead))

// How a member's row stands in its leads' folds, for one any lead leads (undefined for a member
// no one leads): folded away (a lead above it folded, while the person is elsewhere), previewed
// (a click beside a lead above it would fold it away now), unfolding (a lead above it was just
// unfolded, so it unrolls as it comes back), or shown. Any sidebar list with leads and members
// reads it so (team-rows.css), the Terminals list for its tabs (ui's app/team-fold.ts).
export type RowFold = "away" | "preview" | "unfolding" | "shown"

// A lead the person points beside, or just turned over, in a context.
type FoldMark = { readonly context: string; readonly lead: string } | null

export const rowFold = ({
  folded,
  context,
  above,
  kept,
  underSelected,
  selectedAbove,
  preview,
  unfolding,
}: {
  readonly folded: FoldedTeams
  readonly context: string
  // The leads above the member, nearest first, and whether the person is on it or on one below
  // it, which keeps it and the leads between in place.
  readonly above: readonly string[]
  readonly kept: boolean
  // While the person is on a lead above it: the leads from the member up to that one (whose own
  // folds still count, as that lead shows its own team while there), and the leads above the
  // selected one. Empty otherwise.
  readonly underSelected: readonly string[]
  readonly selectedAbove: readonly string[]
  readonly preview: FoldMark
  readonly unfolding: FoldMark
}): RowFold | undefined => {
  if (!above.length) return undefined
  // On a lead a fold above hides, which shows in its place: its own team shows with it, unless
  // it, or a lead between, is folded itself.
  const peeking = underSelected.length > 0 && foldsAway(folded, context, selectedAbove, false)
  const away = peeking
    ? foldsAway(folded, context, underSelected, false)
    : foldsAway(folded, context, above, kept)
  if (away) return "away"
  const under = (mark: FoldMark) =>
    mark !== null && mark.context === context && above.includes(mark.lead)
  if (!kept && under(preview) && !isFolded(folded, context, preview!.lead)) return "preview"
  return under(unfolding) ? "unfolding" : "shown"
}
