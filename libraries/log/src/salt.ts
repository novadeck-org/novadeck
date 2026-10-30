import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const saltPattern = /^[0-9a-f]{64}$/

const read = (file: string): string | undefined => {
  try {
    const salt = readFileSync(file, "utf8").trim()
    return saltPattern.test(salt) ? salt : undefined
  } catch {
    return undefined
  }
}

/**
 * The salt that keys this install's path hashes (see `pathHasher`), kept in `file`, which is
 * made with a fresh one the first time; another process making it at once wins, and both
 * read its salt. Where the file can't be read or made, a salt for this run alone: paths
 * still hash, though not as on another day. The salt is never logged.
 */
export const loadSalt = (file: string): string => {
  const kept = read(file)
  if (kept) return kept
  const fresh = randomBytes(32).toString("hex")
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, fresh, { flag: "wx", mode: 0o600 })
    return fresh
  } catch {
    const other = read(file)
    if (other) return other
  }
  // A file there that holds no salt is replaced.
  try {
    writeFileSync(file, fresh, { mode: 0o600 })
  } catch {
    // This run's salt alone, then.
  }
  return fresh
}
