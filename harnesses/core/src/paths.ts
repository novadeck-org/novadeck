import { posix, win32 } from "node:path"

/**
 * The path rules the given paths are written in, whatever machine this runs on: a drive
 * letter, a backslash or a UNC prefix make them Windows paths, anything else POSIX.
 */
export const flavourOf = (...paths: (string | undefined)[]): typeof posix =>
  paths.some((path) => path !== undefined && /^[A-Za-z]:[\\/]|^\\\\|\\/.test(path)) ? win32 : posix

// A path as a comparison reads it: separators alike, and case folded where it is on a
// Windows drive or share, whose names Windows reads without case.
const comparable = (path: string): string => {
  const rules = flavourOf(path)
  const slashed = rules.normalize(path).replace(/\\/g, "/")
  return rules === win32 && /^(?:[A-Za-z]:\/|\/\/)/.test(slashed) ? slashed.toLowerCase() : slashed
}

/** Whether two paths name the same file: whole paths compared, each in its own rules. */
export const samePath = (a: string, b: string): boolean => comparable(a) === comparable(b)

/**
 * The folder holding the folder `marker` that sits above `path` at the depth a harness lays its
 * files out in: between `min` and `max` folders lie between the marker and the file, as
 * `<home>/projects/<project>/<session>.jsonl` has one. Undefined for a path laid out otherwise,
 * so one that only has a folder of that name somewhere above it (`~/projects/acme/x/s.jsonl`)
 * names no home.
 */
export const homeAbove = (
  path: string,
  marker: string,
  min: number,
  max: number,
): string | undefined => {
  const rules = flavourOf(path)
  let dir = rules.dirname(path)
  for (let between = 0; between <= max && rules.dirname(dir) !== dir; between += 1) {
    if (between >= min && rules.basename(dir) === marker) return rules.dirname(dir)
    dir = rules.dirname(dir)
  }
  return undefined
}

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
