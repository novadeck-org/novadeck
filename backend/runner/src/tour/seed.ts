import { readdir, readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { DomainError } from "../errors.js"

// The seed project the tour writes: real files in `assets/tour/seed`, and the two libraries its
// page runs (Phaser, three.js) as files of their packages. Where they are differs by how the
// runner runs: from the repository (development, tests, a standalone runner) or beside the
// desktop app's resources, which the main process names (`TourAssets`).

/** The folders the seed's files come from, each an absolute path. */
export type TourAssets = {
  /** The seed project's own files. */
  readonly seed: string
  /** The folder of the `phaser` package, or what the tour takes of it. */
  readonly phaser: string
  /** The folder of the `three` package, or what the tour takes of it. */
  readonly three: string
}

/** What is taken of each library, by path inside its folder, and where it lands in `vendor/`. */
const libraries: readonly (readonly [folder: "phaser" | "three", file: string, to: string])[] = [
  ["phaser", "dist/phaser.min.js", "vendor/phaser/phaser.min.js"],
  ["phaser", "LICENSE.md", "vendor/phaser/LICENSE.md"],
  ["three", "build/three.module.js", "vendor/three/build/three.module.js"],
  ["three", "build/three.core.js", "vendor/three/build/three.core.js"],
  [
    "three",
    "examples/jsm/loaders/GLTFLoader.js",
    "vendor/three/examples/jsm/loaders/GLTFLoader.js",
  ],
  [
    "three",
    "examples/jsm/utils/BufferGeometryUtils.js",
    "vendor/three/examples/jsm/utils/BufferGeometryUtils.js",
  ],
  [
    "three",
    "examples/jsm/utils/SkeletonUtils.js",
    "vendor/three/examples/jsm/utils/SkeletonUtils.js",
  ],
  ["three", "LICENSE", "vendor/three/LICENSE"],
]

// The package's own folder, from the file its name resolves to: that is inside it, and its
// `package.json` (not always exported) says which folder it is.
const packageFolder = async (name: string): Promise<string> => {
  let folder = dirname(createRequire(import.meta.url).resolve(name))
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- Walked up one folder at a time.
    const text = await readFile(join(folder, "package.json"), "utf8").catch(() => "")
    if ((JSON.parse(text || "{}") as { name?: string }).name === name) return folder
    const parent = dirname(folder)
    if (parent === folder) throw new Error(`${name} has no package folder`)
    folder = parent
  }
}

// A variable, not a literal in `new URL`, so a bundler doesn't take the folder for an asset to
// copy (as `resolveScript` in thread.ts does).
const seedFolder = "../../assets/tour/seed"

/**
 * Where the seed is when the runner runs from the repository or its build: `assets/tour/seed`
 * two folders above this file (in `src/tour` or `dist/tour`), and the libraries in
 * `node_modules`. The names are looked up at run time, so a bundler takes none of it in.
 */
export const repositoryAssets = async (): Promise<TourAssets> => ({
  seed: fileURLToPath(new URL(seedFolder, import.meta.url)),
  phaser: await packageFolder("phaser"),
  three: await packageFolder("three"),
})

// Every file under `folder`, by its name with `/`, dotfiles too.
const listing = async (folder: string, prefix = ""): Promise<string[]> => {
  const entries = await readdir(join(folder, prefix), { withFileTypes: true })
  const names = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? listing(folder, `${prefix}${entry.name}/`)
        : Promise.resolve([`${prefix}${entry.name}`]),
    ),
  )
  return names.flat()
}

/**
 * The whole file set the tour writes beside its brief's files, by name: the seed's files, and
 * the libraries under `vendor/`. From `assets`, or from the repository where none is given. Where
 * any file can't be read, a `CONFLICT` says so for the person, as a half-written project would
 * be worse than none.
 */
export const seedFiles = async (
  assets?: TourAssets,
): Promise<Readonly<Record<string, Uint8Array>>> => {
  try {
    const from = assets ?? (await repositoryAssets())
    const names = await listing(from.seed)
    const files: [string, Uint8Array][] = await Promise.all([
      ...names.map(async (name): Promise<[string, Uint8Array]> => [
        name,
        await readFile(join(from.seed, name)),
      ]),
      ...libraries.map(async ([folder, file, to]): Promise<[string, Uint8Array]> => [
        to,
        await readFile(join(from[folder], file)),
      ]),
    ])
    const all = Object.fromEntries(files)
    // The seed's `.gitignore` keeps `vendor/` out of the sandbox's repo. A copy that lost it (a
    // packager that leaves dotfiles out) gets the line back, as the libraries' size would
    // otherwise be in every worktree and every search.
    all[".gitignore"] ??= Buffer.from("vendor/\n")
    return all
  } catch (error) {
    throw new DomainError(
      "CONFLICT",
      `Novadeck's tour project files couldn't be read here (${(error as Error).message}). Reinstall Novadeck, then take the tour.`,
    )
  }
}
