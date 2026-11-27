import { readdir, realpath, stat } from "node:fs/promises"
import { basename, join, relative, sep } from "node:path"

import { repositoryAt } from "./repo.js"

// The git repositories a project holds: the one its own folder is in, and those nested under it.

/** A repository of a project. */
export type Found = {
  /** Its main checkout's folder, as a real path. */
  readonly home: string
  /** Its git common dir. */
  readonly commonDir: string
  /** Its folder from the project's root with `/` between names; "" for the one the root is in. */
  readonly path: string
  readonly name: string
}

/** How deep under the project's root a nested repository is looked for. */
export const searchDepth = 4
/** The most folders one search looks into. */
export const searchLimit = 5000
/** How long a project's repositories are kept before the folder is searched again. */
export const keptMs = 60_000

/** Folders that hold other things' files, never repositories the person works in. */
const skipped = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  "vendor",
  "venv",
  "__pycache__",
  "Pods",
  "bower_components",
])

const isRepository = async (folder: string): Promise<boolean> => {
  const dot = await stat(join(folder, ".git")).catch(() => undefined)
  if (!dot?.isDirectory()) return false
  return (await stat(join(folder, ".git", "HEAD")).catch(() => undefined))?.isFile() === true
}

/**
 * The repositories of the project whose folder is `cwd`: the one it is in (`path` ""), and every
 * repository with its own `.git` folder under it, down `searchDepth` levels, not into hidden
 * folders, dependency and build folders, symlinks, or another repository. A linked worktree
 * (a `.git` file) is not one: its repository is where its main checkout is. Never throws.
 */
export const repositoriesIn = async (cwd: string): Promise<readonly Found[]> => {
  const root = await realpath(cwd).catch(() => undefined)
  if (root === undefined) return []
  const found = new Map<string, Found>()
  const own = await repositoryAt(root).catch(() => undefined)
  if (own?.ok) {
    const { home, commonDir, name } = own.repository
    found.set(commonDir, { home, commonDir, path: "", name })
  }
  let looked = 0
  let level = [root]
  for (let depth = 0; depth < searchDepth && level.length > 0; depth += 1) {
    const next: string[] = []
    for (const folder of level) {
      if (looked >= searchLimit) break
      looked += 1
      // eslint-disable-next-line no-await-in-loop -- One folder at a time keeps the search light.
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || skipped.has(entry.name)) continue
        const path = join(folder, entry.name)
        // eslint-disable-next-line no-await-in-loop -- As above.
        if (await isRepository(path)) {
          const commonDir = join(path, ".git")
          if (!found.has(commonDir))
            found.set(commonDir, {
              home: path,
              commonDir,
              path: relative(root, path).split(sep).join("/"),
              name: basename(path),
            })
        } else next.push(path)
      }
    }
    level = next
  }
  return [...found.values()].toSorted((a, b) => a.path.localeCompare(b.path))
}

/** `repositoriesIn`, kept for `keptMs` per folder. */
export class KeptRepositories {
  private readonly kept = new Map<
    string,
    { readonly at: number; readonly found: Promise<readonly Found[]> }
  >()

  constructor(private readonly now: () => number = Date.now) {}

  of(cwd: string): Promise<readonly Found[]> {
    const known = this.kept.get(cwd)
    if (known && this.now() - known.at < keptMs) return known.found
    const found = repositoriesIn(cwd)
    this.kept.set(cwd, { at: this.now(), found })
    return found
  }

  /** Forgets every folder, so the next look searches again (a test, or a project removed). */
  clear(): void {
    this.kept.clear()
  }
}
