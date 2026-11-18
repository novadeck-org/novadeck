// How long ago a repository's origin was fetched, in words the Worktrees panel and a compare's
// header share: rounded down to the minute, hour or day, so it does not change by the second.

/** From this old, the remote's refs are said to be old: an hour. */
export const staleFetchMs = 60 * 60_000

/** "just now", "12 min ago", "3 h ago" or "2 d ago". */
export const fetchAge = (fetchedAt: number, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - fetchedAt) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}
