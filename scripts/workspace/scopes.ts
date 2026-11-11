import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

// What a folder outside every package says a change in it can reach, in a `ci-scope.json` of its
// own, as a package says its platform in its package.json. CI runs everything for a change
// outside a package unless the nearest such file above it narrows that, so a folder without one,
// or with one that can't be read, runs everything:
//
//     { "reaches": "repository", "why": "…" }
//
// `repository`: a change there can reach only the repository's own tests (scripts/**/*.test.ts),
// on Linux: what the folder holds runs in CI's Linux jobs or as a developer's tool, never in a
// package or a job on another system. A narrowing is a reasoned entry: `why` says what makes it
// true; scopes.test.ts refuses one where a workflow runs the folder off Linux and in the
// folders that may never be narrowed, and the reach fence (reach.ts) refuses a package's read
// of a narrowed folder it doesn't declare. The nightly full run covers the other systems.

export const scopeFile = "ci-scope.json"

export type Scope = {
  /** The folder the scope covers, relative to the root with `/`. */
  readonly folder: string
  readonly reaches: "repository"
  readonly why: string
}

/** A scope file's text as a scope for `folder`, or `undefined` where it isn't one. */
export const readScope = (folder: string, text: string): Scope | undefined => {
  try {
    const { reaches, why, ...rest } = JSON.parse(text) as Record<string, unknown>
    if (reaches !== "repository" || Object.keys(rest).length > 0) return undefined
    if (typeof why !== "string" || why.trim() === "") return undefined
    return { folder, reaches, why }
  } catch {
    return undefined
  }
}

/** The scope over a path relative to the root (the nearest scope file above it), if any. */
export const scopeOver = (scopes: readonly Scope[], path: string): Scope | undefined =>
  scopes
    .filter(({ folder }) => path.startsWith(`${folder}/`))
    .toSorted((a, b) => b.folder.length - a.folder.length)[0]

/**
 * The scope over a path relative to `root`, read from the files themselves: the nearest
 * `ci-scope.json` in the folders above it, short of the root, whose own would cover everything
 * and is never read. `undefined` where there is none, or where the nearest can't be read.
 */
export const scopeAbove = (root: string, path: string): Scope | undefined => {
  for (let folder = dirname(path); folder !== "." && folder !== "/" && folder !== "";) {
    const file = join(root, folder, scopeFile)
    if (existsSync(file)) return readScope(folder.replaceAll("\\", "/"), readFileSync(file, "utf8"))
    const parent = dirname(folder)
    if (parent === folder) break
    folder = parent
  }
  return undefined
}

/** Whether a file outside every package is prose, which no test or build may read. */
export const isProse = (path: string): boolean => path.endsWith(".md")
