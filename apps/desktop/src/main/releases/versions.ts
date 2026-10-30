// A version as numbers and a prerelease tag, or undefined for text that is not one.
const parseVersion = (
  version: string,
): { readonly numbers: readonly number[]; readonly pre: string | undefined } | undefined => {
  const match = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?$/u.exec(version.trim())
  if (!match) return undefined
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] }
}

/**
 * Whether `existing` is a newer version than `running`. A version that is not a release's
 * is not newer. A release is newer than its own prereleases; prereleases compare as text.
 */
export const isNewerVersion = (existing: string, running: string): boolean => {
  const [one, other] = [parseVersion(existing), parseVersion(running)]
  if (!one || !other) return false
  for (const [index, number] of one.numbers.entries()) {
    const against = other.numbers[index] ?? 0
    if (number !== against) return number > against
  }
  if (one.pre === other.pre) return false
  if (one.pre === undefined) return true
  if (other.pre === undefined) return false
  return one.pre > other.pre
}
