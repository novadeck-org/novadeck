import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, posix } from "node:path"

import { describe, expect, it } from "vitest"

import { desktopUtilities } from "./bundle-checks.ts"

// The guards say a build's CSS lost a folder Tailwind scans only if no other file Tailwind
// scans can make the guard's class: a copy of it in the UI's own files, a config or a comment
// would generate the class, and the build would pass however much the scan lost.

const root = join(import.meta.dirname, "..", "..", "..")
const sheet = "frontend/ui/src/styles.css"
const css = readFileSync(join(root, sheet), "utf8")

// The folders the stylesheet scans: its own `source(...)` and each `@source` line.
const scanned = [
  ...[...css.matchAll(/source\("([^"]+)"\)/g)].map((match) => match[1]!),
  ...[...css.matchAll(/^@source "([^"]+)";/gm)].map((match) => match[1]!),
].map((path) => posix.normalize(posix.join(posix.dirname(sheet), path)))

// What the sheet leaves out with `@source not`, each as the folder it names and the file suffix.
const left = [...css.matchAll(/^@source not "([^"]+)\/\*\*\/\*(\.[^"/*]+)";/gm)].map((match) => ({
  folder: posix.normalize(posix.join(posix.dirname(sheet), match[1]!)),
  suffix: match[2]!,
}))

// What Tailwind never reads: folders git ignores, stylesheets and binary files.
const skipped = new Set(["node_modules", "dist", "dist-web", ".vitest", "test-results", "coverage"])
const binary =
  /\.(?:css|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp[34]|webm|pdf|zip|gz|map|lock|wasm)$/
const filesUnder = (folder: string): string[] =>
  readdirSync(join(root, folder), { withFileTypes: true }).flatMap((entry) =>
    skipped.has(entry.name)
      ? []
      : entry.isDirectory()
        ? filesUnder(`${folder}/${entry.name}`)
        : [`${folder}/${entry.name}`],
  )

// Every other file: the sheet's `@source not` lines are all that leave anything out.
const files = [...new Set(scanned.flatMap(filesUnder))].filter(
  (file) =>
    !binary.test(file) &&
    !left.some(({ folder, suffix }) => file.startsWith(`${folder}/`) && file.endsWith(suffix)),
)

const holds = (file: string, utility: string): boolean =>
  new RegExp(`(?<![\\w-])${utility.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(
    readFileSync(join(root, file), "utf8"),
  )

describe("the Tailwind guards", () => {
  it("leave out only what the sheet leaves out: each scanned folder's tests, as `.test.ts`", () => {
    expect(left.length).toBeGreaterThan(0)
    expect(files.filter((file) => /^frontend\/[^/]+\/src\/.*\.test\.ts$/.test(file))).toEqual([])
    // Every other kind of file, a test of another kind among them, is read as Tailwind reads it.
    expect(files.some((file) => /\.(?:tsx|mts|json|md|html)$/.test(file))).toBe(true)
  })

  it("read the folders the stylesheet scans, and the guarded ones are among them", () => {
    expect(scanned.length).toBeGreaterThan(2)
    for (const { folder } of desktopUtilities)
      expect(scanned.some((path) => folder.startsWith(`${path.replace(/\/src$/, "")}/`))).toBe(true)
    expect(files.length).toBeGreaterThan(100)
    for (const path of scanned) expect(statSync(join(root, path)).isDirectory()).toBe(true)
  })

  it.each(desktopUtilities)(
    "keep $folder's utility out of every scanned file outside it",
    ({ folder, utility }) => {
      const outside = files.filter((file) => !file.startsWith(folder) && holds(file, utility))
      expect(outside).toEqual([])
    },
  )

  it.each(desktopUtilities)(
    "find $folder's utility in a file of the folder",
    ({ folder, utility }) => {
      expect(files.some((file) => file.startsWith(folder) && holds(file, utility))).toBe(true)
    },
  )
})
