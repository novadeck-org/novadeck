// What PR 0 of the UI split moves into `frontend/toolkit`, and how each import that names it is
// rewritten: pure, so move-toolkit.ts runs it over the tree and its tests run it over text. It
// reuses the specifier reader and resolver of step 5's move (scripts/packages/frontend.ts), but
// not its `rewriteImports`: that one places files by the `packages` table of the
// UI before its split, which has no toolkit and must not gain one (its tree test re-runs that move).

import { posix } from "node:path"

import { mapSpecifiers, resolveRelative } from "../packages/frontend.ts"

const ui = "frontend/ui/src"
export const toolkitDir = "frontend/toolkit"
export const toolkitName = "@novadeck/toolkit"
const toolkitSrc = `${toolkitDir}/src`

type Rule = { readonly from: string; readonly to: string }

// A file, or a folder (ending in a slash). The most specific first.
export const rules: readonly Rule[] = [
  { from: `${ui}/class-name.ts`, to: `${toolkitSrc}/class-name.ts` },
  { from: `${ui}/class-name.test.ts`, to: `${toolkitSrc}/class-name.test.ts` },
  { from: `${ui}/sidebar/SidebarItem.tsx`, to: `${toolkitSrc}/SidebarItem.tsx` },
  { from: `${ui}/ui-toolkit/`, to: `${toolkitSrc}/` },
]

/** The UI's own copy of the Vitest re-export, which each package keeps its own of. */
const uiTest = `${ui}/test.ts`
const ownTest = `${toolkitSrc}/test.ts`

const matches = (rule: Rule, path: string, side: "from" | "to"): boolean =>
  rule[side].endsWith("/") ? path.startsWith(rule[side]) : path === rule[side]

/** Where a file of the UI goes; undefined when it stays. */
export const destinationOf = (file: string): string | undefined => {
  const rule = rules.find((each) => matches(each, file, "from"))
  return !rule
    ? undefined
    : rule.from.endsWith("/")
      ? rule.to + file.slice(rule.from.length)
      : rule.to
}

/** Where a file of the toolkit came from; undefined for one that was never the UI's. */
export const originOf = (file: string): string | undefined => {
  if (file === ownTest) return undefined
  const rule = rules.find((each) => matches(each, file, "to"))
  return !rule
    ? undefined
    : rule.to.endsWith("/")
      ? rule.from + file.slice(rule.to.length)
      : rule.from
}

/** The specifier that names `target`, a file of the toolkit, from another package. */
export const crossSpecifier = (target: string): string => {
  const inside = target.slice(`${toolkitSrc}/`.length)
  return `${toolkitName}/${inside.replace(/\.(?:tsx?)$/, "")}`
}

const relativeTo = (file: string, target: string): string => {
  const path = posix.relative(posix.dirname(file), target)
  return path.startsWith(".") ? path : `./${path}`
}

export type Rewritten = { readonly text: string; readonly problems: string[] }

/**
 * The text of `file` (at the path it has now) with each relative specifier that names a moved
 * file pointed where it goes: `@novadeck/toolkit/<module>` from outside the toolkit, a
 * relative path inside it. `tracked` is what the repository holds; a moved file is found at
 * either end, so a branch that added an import of a file the move already took still resolves.
 * A specifier of a moved file that can't be placed is a problem, not a guess.
 */
export const rewriteSpecifiers = (
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
  }
  const newFile = destinationOf(file) ?? file
  const inside = newFile.startsWith(`${toolkitSrc}/`)
  const next = (specifier: string, line: number): string => {
    if (!/^\.\.?(?:\/|$)/.test(specifier)) return specifier
    const query = /\?.*$/.exec(specifier)?.[0] ?? ""
    // A file a merge's directory rename took into the toolkit still names its siblings and the
    // UI's files as it did at its old place: resolve from there.
    const origin = inside ? originOf(file) : undefined
    const resolved =
      resolveRelative(file, specifier, known) ??
      (origin ? resolveRelative(origin, specifier, known) : undefined)
    if (!resolved) {
      // Only what a moved file reads, or what names a moved module, is the move's to place.
      if (inside || /ui-toolkit|class-name|SidebarItem/.test(specifier))
        problems.push(`${file}:${line}: ${JSON.stringify(specifier)} names no file here`)
      return specifier
    }
    const { target, suffix } = resolved
    // The Vitest re-export is each package's own.
    const newTarget = inside && target === uiTest ? ownTest : (destinationOf(target) ?? target)
    const toolkitTarget = newTarget.startsWith(`${toolkitSrc}/`)
    if (inside && !toolkitTarget) {
      problems.push(
        `${file}:${line}: ${JSON.stringify(specifier)} names ${target}, which the toolkit can't reach`,
      )
      return specifier
    }
    if (!inside && !toolkitTarget) return specifier
    if (!inside) return crossSpecifier(newTarget) + query
    const stem = newTarget.endsWith(suffix)
      ? newTarget.slice(0, newTarget.length - suffix.length)
      : newTarget
    return relativeTo(newFile, stem) + query
  }
  return { text: mapSpecifiers(file, text, next), problems }
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

/** The `package.json` export key of a toolkit file, or undefined for one that isn't exported. */
export const exportKeyOf = (file: string): string | undefined => {
  if (!file.startsWith(`${toolkitSrc}/`)) return undefined
  const inside = file.slice(`${toolkitSrc}/`.length)
  if (inside === "test.ts" || /\.test\.tsx?$/.test(inside)) return undefined
  return `./${inside.replace(/\.tsx?$/, "")}`
}

/** The exports the manifest lacks for `files` (toolkit files, at their new places). */
export const missingExports = (files: Iterable<string>, exported: ReadonlySet<string>): string[] =>
  [...new Set(files)].flatMap((file) => {
    const key = exportKeyOf(file)
    return key !== undefined && !exported.has(key) ? [`${file} has no "${key}" export`] : []
  })
