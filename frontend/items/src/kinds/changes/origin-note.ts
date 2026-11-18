import { fetchAge, staleFetchMs } from "@novadeck/core/fetch-age"
import type { ChangesContent } from "@novadeck/core/items"

// What a compare of remote refs says of how current they are, only where that is in doubt: the
// last fetch failed (the reason in the title), origin was never fetched, or it was fetched over an
// hour ago. Amber where it is something to act on, as the Worktrees panel says its main is old.
export const originNote = (
  origin: ChangesContent["origin"],
  now: number,
): { readonly text: string; readonly title?: string; readonly stale: boolean } | undefined => {
  if (!origin) return undefined
  const { fetchedAt, failed } = origin
  const last = fetchedAt === undefined ? "" : ` · last fetched ${fetchAge(fetchedAt, now)}`
  if (failed !== undefined)
    return { text: `origin fetch failed${last}`, title: failed, stale: true }
  if (fetchedAt === undefined) return { text: "origin not fetched yet", stale: false }
  if (now - fetchedAt >= staleFetchMs)
    return { text: `origin last fetched ${fetchAge(fetchedAt, now)}`, stale: true }
  return undefined
}
