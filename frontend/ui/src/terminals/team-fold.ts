// Teams the person folded into their leads in the Terminals list. Teammates are top-level
// tabs like any agent's; folding is for someone who only follows the lead: it hides the
// teammates' tabs from the list, and nothing else (Grid, Canvas, the switcher and the Inbox
// still show them). Remembered on this computer, by session, by the lead's terminal. How a row
// stands in the folds is the toolkit's (team-fold.ts), for any sidebar list with teams.
import { type FoldedTeams } from "@novadeck/toolkit/team-fold"

export const noFoldedTeams: FoldedTeams = {}

export const foldedTeamsStorageKey = "novadeck.folded-teams"

// How many sessions are remembered: the least recently changed are forgotten past it, so a
// person's sessions over months don't pile up in storage.
const rememberedSessions = 50

// Folds the lead's team, or shows it again if it was folded.
export const toggleFolded = (folded: FoldedTeams, context: string, lead: string): FoldedTeams => {
  const leads = folded[context] ?? []
  const next = leads.includes(lead) ? leads.filter((id) => id !== lead) : [...leads, lead]
  const { [context]: _changed, ...rest } = folded
  const kept = Object.entries(rest).slice(-(rememberedSessions - 1))
  return Object.fromEntries(next.length ? [...kept, [context, next]] : kept)
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
