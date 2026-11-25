// How long a repository's origin has failed to fetch, in the footer's words: rounded down to the
// minute, hour or day, so it does not change by the second.

/**
 * How long fetches fail before the app says so: an hour. The runner fetches every five minutes
 * and waits longer after each failure, so a passing blip never shows.
 */
export const staleFetchMs = 60 * 60_000

/** "1 min", "12 min", "3 h" or "2 d": at least a minute. */
export const failingFor = (since: number, now: number): string => {
  const minutes = Math.max(1, Math.floor((now - since) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}
