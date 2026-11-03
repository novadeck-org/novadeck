import { posix, win32 } from "node:path"

/**
 * The path rules the given paths are written in, whatever machine this runs on: a drive
 * letter, a backslash or a UNC prefix make them Windows paths, anything else POSIX.
 */
export const flavourOf = (...paths: (string | undefined)[]): typeof posix =>
  paths.some((path) => path !== undefined && /^[A-Za-z]:[\\/]|^\\\\|\\/.test(path)) ? win32 : posix

// A path as a comparison reads it: separators alike, and case folded where it is a Windows
// drive's.
const comparable = (path: string): string => {
  const slashed = flavourOf(path).normalize(path).replace(/\\/g, "/")
  return /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed
}

/** Whether two paths name the same file: whole paths compared, each in its own rules. */
export const samePath = (a: string, b: string): boolean => comparable(a) === comparable(b)

/**
 * `folder` beside the nearest folder above `path` named `marker`, in the rules `path` is
 * written in: `/home/a/.claude-work/projects/x/s.jsonl` with `projects` and `plans` gives
 * `/home/a/.claude-work/plans`. Empty when no folder above it has that name.
 */
export const beside = (path: string, marker: string, folder: string): readonly string[] => {
  const rules = flavourOf(path)
  for (let dir = rules.dirname(path); rules.dirname(dir) !== dir; dir = rules.dirname(dir))
    if (rules.basename(dir) === marker) return [rules.join(rules.dirname(dir), folder)]
  return []
}
