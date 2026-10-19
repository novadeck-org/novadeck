// What the UI split's moves share (PRs 0 and 1a, and the chat's later): a table of what goes
// into a package, and how each import that names a moved file is rewritten. Pure, so a
// move-<name>.ts script runs it over the tree and its tests run it over text. It reuses the
// specifier reader and resolver of step 5's move (scripts/packages/frontend.ts), but not its
// `rewriteImports`: that one places files by the `packages` table of the UI before its split,
// which has no such package and must not gain one (its tree test re-runs that move).

import { posix } from "node:path"

import { mapSpecifiers, resolveRelative } from "../packages/frontend.ts"

export const ui = "frontend/ui/src"
/** The UI's own copy of the Vitest re-export, which each package keeps its own of. */
export const uiTest = `${ui}/test.ts`

export type Rule = { readonly from: string; readonly to: string }

/** What another move of the split says about its files, so this one can name them. */
export type Other = {
  readonly destinationOf: (file: string) => string | undefined
  readonly originOf: (file: string) => string | undefined
  readonly crossSpecifier: (target: string) => string
}

export type MoveConfig = {
  /** The package's folder, `frontend/<name>`. */
  readonly dir: string
  /** The package's name, `@novadeck/<name>`. */
  readonly name: string
  /** A file, or a folder (ending in a slash). The most specific first. */
  readonly rules: readonly Rule[]
  /** What a specifier that resolves to nothing must look like to be the move's to place. */
  readonly names: RegExp
  /**
   * The moves that landed before this one. A file of this package that names a file they
   * moved (an old branch's `../../ui-toolkit/Portal`) imports it from their package, whether
   * the file is still at its old place or already at the new.
   */
  readonly others?: readonly Other[]
}

const matches = (rule: Rule, path: string, side: "from" | "to"): boolean =>
  rule[side].endsWith("/") ? path.startsWith(rule[side]) : path === rule[side]

const relativeTo = (file: string, target: string): string => {
  const path = posix.relative(posix.dirname(file), target)
  return path.startsWith(".") ? path : `./${path}`
}

export type Rewritten = { readonly text: string; readonly problems: string[] }

export const createMove = ({ dir, name, rules, names, others = [] }: MoveConfig) => {
  const src = `${dir}/src`
  const ownTest = `${src}/test.ts`

  /** Where a file of the UI goes; undefined when it stays. */
  const destinationOf = (file: string): string | undefined => {
    const rule = rules.find((each) => matches(each, file, "from"))
    return !rule
      ? undefined
      : rule.from.endsWith("/")
        ? rule.to + file.slice(rule.from.length)
        : rule.to
  }

  /** Where a file of the package came from; undefined for one that was never the UI's. */
  const originOf = (file: string): string | undefined => {
    if (file === ownTest) return undefined
    const rule = rules.find((each) => matches(each, file, "to"))
    return !rule
      ? undefined
      : rule.to.endsWith("/")
        ? rule.from + file.slice(rule.to.length)
        : rule.from
  }

  /** The specifier that names `target`, a file of the package, from another package. */
  const crossSpecifier = (target: string): string => {
    const inside = target.slice(`${src}/`.length)
    return `${name}/${inside.replace(/\.(?:tsx?)$/, "")}`
  }

  /**
   * The text of `file` (at the path it has now) with each relative specifier that names a moved
   * file pointed where it goes: `<name>/<module>` from outside the package, a relative path
   * inside it. `tracked` is what the repository holds; a moved file is found at either end, so
   * a branch that added an import of a file the move already took still resolves. A specifier
   * of a moved file that can't be placed is a problem, not a guess.
   */
  const rewriteSpecifiers = (
    file: string,
    text: string,
    tracked: ReadonlySet<string>,
  ): Rewritten => {
    const problems: string[] = []
    // The package's own test.ts counts as there whether or not it is written yet.
    const known = new Set([...tracked, ownTest])
    for (const each of tracked) {
      const origin = originOf(each)
      if (origin) known.add(origin)
      for (const other of others) {
        const before = other.originOf(each)
        if (before) known.add(before)
      }
    }
    const newFile = destinationOf(file) ?? file
    const inside = newFile.startsWith(`${src}/`)
    const next = (specifier: string, line: number): string => {
      if (!/^\.\.?(?:\/|$)/.test(specifier)) return specifier
      const query = /\?.*$/.exec(specifier)?.[0] ?? ""
      // A file a merge's directory rename took into the package still names its siblings and
      // the UI's files as it did at its old place: resolve from there.
      const origin = inside ? originOf(file) : undefined
      const resolved =
        resolveRelative(file, specifier, known) ??
        (origin ? resolveRelative(origin, specifier, known) : undefined)
      if (!resolved) {
        // Only what a moved file reads, or what names a moved module, is the move's to place.
        if (inside || names.test(specifier))
          problems.push(`${file}:${line}: ${JSON.stringify(specifier)} names no file here`)
        return specifier
      }
      const { target, suffix } = resolved
      if (inside) {
        // A file another move took (or is about to take) is that package's to name.
        for (const other of others) {
          const there = other.destinationOf(target) ?? (other.originOf(target) ? target : undefined)
          if (there) return other.crossSpecifier(there) + query
        }
      }
      // The Vitest re-export is each package's own.
      const newTarget = inside && target === uiTest ? ownTest : (destinationOf(target) ?? target)
      const packageTarget = newTarget.startsWith(`${src}/`)
      if (inside && !packageTarget) {
        problems.push(
          `${file}:${line}: ${JSON.stringify(specifier)} names ${target}, which ${name} can't reach`,
        )
        return specifier
      }
      if (!inside && !packageTarget) return specifier
      if (!inside) return crossSpecifier(newTarget) + query
      const stem = newTarget.endsWith(suffix)
        ? newTarget.slice(0, newTarget.length - suffix.length)
        : newTarget
      return relativeTo(newFile, stem) + query
    }
    return { text: mapSpecifiers(file, text, next), problems }
  }

  /** The `package.json` export key of a file of the package, or undefined for one that isn't. */
  const exportKeyOf = (file: string): string | undefined => {
    if (!file.startsWith(`${src}/`)) return undefined
    const inside = file.slice(`${src}/`.length)
    if (inside === "test.ts" || /\.test\.tsx?$/.test(inside)) return undefined
    return `./${inside.replace(/\.tsx?$/, "")}`
  }

  return { src, ownTest, destinationOf, originOf, crossSpecifier, rewriteSpecifiers, exportKeyOf }
}

/** Inserts `line` after the line that holds `anchor`, unless the text has it already. */
export const insertAfter = (text: string, anchor: string, line: string): string | undefined => {
  if (text.includes(line)) return text
  const at = text.indexOf(anchor)
  if (at < 0) return undefined
  const end = text.indexOf("\n", at)
  return `${text.slice(0, end + 1)}${line}\n${text.slice(end + 1)}`
}

/** Inserts `line` on its own line just before the line that holds `anchor`, unless it is there. */
export const insertBefore = (text: string, anchor: string, line: string): string | undefined => {
  if (text.includes(line)) return text
  const at = text.indexOf(anchor)
  if (at < 0) return undefined
  const start = text.lastIndexOf("\n", at) + 1
  return `${text.slice(0, start)}${line}\n${text.slice(start)}`
}
