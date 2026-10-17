import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

import { build } from "esbuild"

// The lint fence (`.oxlintrc.json`) sees an import only where it's written, so a browser
// subpath that reaches Node through a module of its own, or through a dependency, gets past
// it. This bundles each library's browser subpaths for the browser, as the UI would, and
// fails on any Node built-in or native module they pull in.

/** A library's `exports`: a target, fallbacks, or conditions mapping to more of them. */
type Target = string | readonly Target[] | { readonly [condition: string]: Target } | null
type Manifest = { readonly name: string; readonly exports?: Target }

/** A library subpath the browser imports, and the source file it starts from. */
export type Entry = { readonly subpath: string; readonly file: string }

/** What a browser subpath pulls in that the browser can't run. */
export type Problem = {
  readonly library: string
  readonly subpath: string
  readonly problem: string
}

// The conditions a browser bundle matches, as the UI's dev build does: source first.
const conditions = new Set(["development", "browser", "module", "import", "default"])

/**
 * The file a target resolves to for the browser, null where it's left unexported, or
 * undefined where nothing in it matches: the first of its fallbacks that gives a file, and
 * the first matching condition that gives an answer, as resolution moves on past a nested
 * one that matches nothing but stops at a `null`.
 */
const browserFile = (target: Target): string | null | undefined => {
  if (typeof target === "string" || target === null) return target
  if (Array.isArray(target)) return target.map(browserFile).find(Boolean)
  return Object.entries(target as { readonly [condition: string]: Target })
    .filter(([condition]) => conditions.has(condition))
    .map(([, next]) => browserFile(next))
    .find((file) => file !== undefined)
}

/**
 * The subpaths a library's browser code may import. A subpath that only Node may import
 * names nothing but the `node` condition, as `"./pty": { "node": { ... } }`, and is left out.
 */
export const browserEntries = (manifest: Manifest): readonly Entry[] => {
  const { exports } = manifest
  const map =
    typeof exports === "object" &&
    exports &&
    !Array.isArray(exports) &&
    Object.keys(exports).every((key) => key.startsWith("."))
      ? (exports as { readonly [subpath: string]: Target })
      : { ".": exports ?? null }
  return Object.entries(map).flatMap(([subpath, target]) => {
    const file = browserFile(target)
    return file ? [{ subpath, file }] : []
  })
}

/** Whether the package a file belongs to builds a native addon. */
const isNative = (file: string): boolean => {
  for (let folder = dirname(file); ; folder = dirname(folder)) {
    const manifest = join(folder, "package.json")
    if (existsSync(manifest)) {
      const { gypfile } = JSON.parse(readFileSync(manifest, "utf8")) as { gypfile?: boolean }
      return gypfile === true || existsSync(join(folder, "binding.gyp"))
    }
    if (dirname(folder) === folder) return false
  }
}

type Message = { readonly text: string; readonly location?: { readonly file: string } | null }

/** An esbuild error, with the file it was found in. */
const describe = ({ text, location }: Message) => (location ? `${location.file}: ${text}` : text)

/** What one browser subpath of the library in `folder` pulls in that the browser can't run. */
const checkEntry = async (folder: string, entry: Entry): Promise<readonly string[]> => {
  const bundle = () =>
    build({
      absWorkingDir: folder,
      entryPoints: [entry.file],
      bundle: true,
      write: false,
      outdir: "out",
      platform: "browser",
      format: "esm",
      conditions: ["development"],
      loader: { ".woff": "empty", ".woff2": "empty", ".png": "empty", ".svg": "empty" },
      metafile: true,
      logLevel: "silent",
    })
  try {
    const { metafile } = await bundle()
    return Object.keys(metafile.inputs)
      .map((input) => resolve(folder, input))
      .filter(isNative)
      .map((file) => `${relative(folder, file)} belongs to a native module`)
  } catch (error) {
    // esbuild throws its errors; anything else that throws is a failure of its own.
    const errors = (error as { errors?: readonly Message[] } | undefined)?.errors
    return errors?.length ? errors.map(describe) : [String(error)]
  }
}

/** What the browser subpaths of the library in `folder` pull in that the browser can't run. */
export const checkLibrary = async (folder: string): Promise<readonly Problem[]> => {
  const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as Manifest
  // Without exports nothing tells its browser subpaths from its Node ones.
  const { exports } = manifest
  if (
    exports === undefined ||
    exports === null ||
    (typeof exports === "object" && Object.keys(exports).length === 0)
  )
    return [{ library: manifest.name, subpath: ".", problem: "package.json has no exports" }]
  // Subpaths that are every one null export nothing at all, which no import can reach.
  if (
    typeof exports === "object" &&
    !Array.isArray(exports) &&
    Object.values(exports).every((target) => target === null)
  )
    return [{ library: manifest.name, subpath: ".", problem: "package.json exports nothing" }]
  const results = await Promise.all(
    browserEntries(manifest).map(async (entry) =>
      (await checkEntry(folder, entry)).map((problem) => ({
        library: manifest.name,
        subpath: entry.subpath,
        problem,
      })),
    ),
  )
  return results.flat()
}

/** The library folders in `root`: each folder with a package.json. */
export const libraries = (root: string): readonly string[] =>
  existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((each) => each.isDirectory() && existsSync(join(root, each.name, "package.json")))
        .map((each) => join(root, each.name))
    : []
