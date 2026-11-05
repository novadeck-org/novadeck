// Teams the person folded into their leads in the Terminals list. Teammates are top-level
// tabs like any agent's; folding is for someone who only follows the lead: it hides the
// teammates' tabs from the list, and nothing else (Grid, Canvas, the switcher and the Inbox
// still show them). Remembered on this computer, by session, by the lead's terminal.

// Each session's folded leads, by session context (`currentContext`), most recently changed
// session last.
export type FoldedTeams = Readonly<Record<string, readonly string[]>>

export const noFoldedTeams: FoldedTeams = {}

export const foldedTeamsStorageKey = "novadeck.folded-teams"

// How many sessions are remembered: the least recently changed are forgotten past it, so a
// person's sessions over months don't pile up in storage.
const rememberedSessions = 50

export const isFolded = (folded: FoldedTeams, context: string, lead: string): boolean =>
  folded[context]?.includes(lead) ?? false

// Folds the lead's team, or shows it again if it was folded.
export const toggleFolded = (folded: FoldedTeams, context: string, lead: string): FoldedTeams => {
  const leads = folded[context] ?? []
  const next = leads.includes(lead) ? leads.filter((id) => id !== lead) : [...leads, lead]
  const { [context]: _changed, ...rest } = folded
  const kept = Object.entries(rest).slice(-(rememberedSessions - 1))
  return Object.fromEntries(next.length ? [...kept, [context, next]] : kept)
}

// Whether a terminal's tab folds away: one under a folded lead, at any depth (a fold covers the
// teams its teammates lead too), unless the person is on it, or on one below it, which shows in
// its place with the leads between (as when an Inbox row took them there) and folds away again
// once they move on. `above` is the leads above it, nearest first; `kept` says the person is on
// it or below it.
export const foldsAway = (
  folded: FoldedTeams,
  context: string,
  above: readonly string[],
  kept: boolean,
): boolean => !kept && above.some((lead) => isFolded(folded, context, lead))

// A tab order after a drag, with each folded lead's hidden tabs moved back right after it, in
// their own order. They hold places in the list the person can't see, so a drag past a folded
// lead would otherwise leave its team behind, or land a tab inside it, and its unfold would
// show the team split.
export const keepFoldsTogether = (
  order: readonly string[],
  folds: readonly { readonly lead: string; readonly hidden: readonly string[] }[],
): string[] => {
  let next = [...order]
  for (const { lead, hidden } of folds) {
    const moving = next.filter((id) => hidden.includes(id))
    if (!moving.length || !next.includes(lead)) continue
    next = next.filter((id) => !hidden.includes(id))
    next.splice(next.indexOf(lead) + 1, 0, ...moving)
  }
  return next
}

const isLeads = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === "string")

export const readFoldedTeams = (): FoldedTeams => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(foldedTeamsStorageKey) ?? "null")
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return noFoldedTeams
    return Object.fromEntries(Object.entries(stored).filter(([, leads]) => isLeads(leads)))
  } catch {
    return noFoldedTeams
  }
}

export const writeFoldedTeams = (folded: FoldedTeams): void => {
  try {
    if (Object.keys(folded).length)
      localStorage.setItem(foldedTeamsStorageKey, JSON.stringify(folded))
    else localStorage.removeItem(foldedTeamsStorageKey)
  } catch {
    /* The folds hold for this run of the app when storage is unavailable. */
  }
}
