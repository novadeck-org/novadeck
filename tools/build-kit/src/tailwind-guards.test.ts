import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { join, posix, relative, sep } from "node:path"

import { describe, expect, it } from "vitest"

import { frontendUtilities, missingUtilities, unguardedFolders } from "./bundle-checks.ts"

// The guards say a build's CSS lost a folder Tailwind scans only if nothing else can make the
// guard's class: a copy of it in another scanned file (the UI's own, a config or a comment), a
// class the stylesheet always makes (`@source inline(...)`), or a rule of that name in a sheet
// the build reads would put the class in the CSS however much the scan lost.

const root = join(import.meta.dirname, "..", "..", "..")
const sheet = "frontend/ui/src/styles.css"
const css = readFileSync(join(root, sheet), "utf8")

// The folders the stylesheet scans: its own `source(...)` and each `@source` line.
const scanned = [
  ...[...css.matchAll(/source\("([^"]+)"\)/g)].map((match) => match[1]!),
  ...[...css.matchAll(/^@source "([^"]+)";/gm)].map((match) => match[1]!),
].map((path) => posix.normalize(posix.join(posix.dirname(sheet), path)))

// A scanned folder as the guards name it: its package's folder.
const packageOf = (path: string): string => `${path.replace(/\/src$/, "")}/`

// What the sheet leaves out with `@source not`, each as the folder it names and the file suffix.
const left = [...css.matchAll(/^@source not "([^"]+)\/\*\*\/\*(\.[^"/*]+)";/gm)].map((match) => ({
  folder: posix.normalize(posix.join(posix.dirname(sheet), match[1]!)),
  suffix: match[2]!,
}))

// The files under the scanned folders that Tailwind reads as git sees them: tracked or new, and
// not ignored (Tailwind skips what git ignores, such as a package's .turbo logs and env files).
const listed = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...scanned],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\0")
  .filter((file) => file !== "" && existsSync(join(root, file)))
const underScanned = [...new Set(listed)]

// What Tailwind never reads for classes: stylesheets and binary files.
const binary =
  /\.(?:css|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp[34]|webm|pdf|zip|gz|map|lock|wasm)$/

// Every other file: the sheet's `@source not` lines are all that leave anything out.
const files = underScanned.filter(
  (file) =>
    !binary.test(file) &&
    !left.some(({ folder, suffix }) => file.startsWith(`${folder}/`) && file.endsWith(suffix)),
)

const holds = (file: string, utility: string): boolean =>
  new RegExp(`(?<![\\w-])${utility.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(
    readFileSync(join(root, file), "utf8"),
  )

// The candidates a Tailwind `inline(...)` source names, its braces expanded: `{a,b}` each, and
// `{1..3}` or `{100..900..100}` each number of the range.
const expanded = (pattern: string): string[] => {
  const open = pattern.indexOf("{")
  if (open === -1) return [pattern]
  let depth = 0
  let close = open
  const commas: number[] = []
  for (let at = open; at < pattern.length; at++) {
    if (pattern[at] === "{") depth++
    else if (pattern[at] === "}" && --depth === 0) {
      close = at
      break
    } else if (pattern[at] === "," && depth === 1) commas.push(at)
  }
  if (close === open) return [pattern]
  const inside = pattern.slice(open + 1, close)
  const range = /^(-?\d+)\.\.(-?\d+)(?:\.\.(\d+))?$/.exec(inside)
  const choices = range
    ? Array.from(
        { length: Math.floor(Math.abs(+range[2]! - +range[1]!) / +(range[3] ?? 1)) + 1 },
        (_, at) => String(+range[1]! + Math.sign(+range[2]! - +range[1]!) * at * +(range[3] ?? 1)),
      )
    : [open, ...commas].map((start, at) => pattern.slice(start + 1, [...commas, close][at]))
  const rest = expanded(pattern.slice(close + 1))
  return choices.flatMap((choice) =>
    expanded(`${pattern.slice(0, open)}${choice}`).flatMap((head) =>
      rest.map((tail) => head + tail),
    ),
  )
}

// The guards a stylesheet always makes, whatever is scanned: its positive `@source inline(...)`.
const inlinedGuards = (text: string): string[] => {
  const named = new Set(
    [...text.matchAll(/@source\s+inline\(\s*(["'])(.*?)\1\s*\)/g)].flatMap(([, , list]) =>
      list!.split(/\s+/).flatMap(expanded),
    ),
  )
  return frontendUtilities.map(({ utility }) => utility).filter((utility) => named.has(utility))
}

// The guards a hand-written stylesheet writes a rule for, as Tailwind would name the class.
const ruledGuards = (text: string): string[] =>
  frontendUtilities
    .filter(
      (guard) =>
        missingUtilities({ "a.css": { type: "asset", fileName: "a.css", source: text } }, [guard])
          .length === 0,
    )
    .map(({ utility }) => utility)

// Every stylesheet the build reads by the UI's sheet: the sheets under the scanned folders, and
// what each of them imports, and so on, from wherever they resolve (Tailwind's own aside).
const sheets = (() => {
  const found = new Set<string>()
  const visit = (file: string): void => {
    if (found.has(file)) return
    found.add(file)
    for (const [, path = ""] of readFileSync(join(root, file), "utf8").matchAll(
      /^@import\s+["']([^"']+)["']/gm,
    )) {
      if (path === "tailwindcss") continue
      visit(
        path.startsWith(".")
          ? posix.normalize(posix.join(posix.dirname(file), path))
          : relative(root, createRequire(join(root, file)).resolve(path))
              .split(sep)
              .join("/"),
      )
    }
  }
  for (const file of [sheet, ...underScanned.filter((each) => each.endsWith(".css"))]) visit(file)
  return [...found]
})()

describe("the Tailwind guards", () => {
  it("leave out only what the sheet leaves out: each scanned folder's `.test.ts` and `.test.tsx`", () => {
    const folders = (kind: string) =>
      left.filter(({ suffix }) => suffix === kind).map(({ folder }) => folder)
    expect(folders(".test.ts").length).toBeGreaterThan(0)
    expect(folders(".test.tsx")).toEqual(folders(".test.ts"))
    expect(files.filter((file) => /^frontend\/[^/]+\/src\/.*\.test\.tsx?$/.test(file))).toEqual([])
    // Every other kind of file, a test of another kind among them, is read as Tailwind reads it.
    expect(files.some((file) => /\.(?:tsx|mts|json|md|html)$/.test(file))).toBe(true)
  })

  it("read the folders the stylesheet scans, as git lists them", () => {
    expect(scanned.length).toBeGreaterThan(2)
    expect(files.length).toBeGreaterThan(100)
    for (const path of scanned) expect(statSync(join(root, path)).isDirectory()).toBe(true)
    // What git ignores is no file Tailwind reads, as a log under a package's .turbo.
    expect(files.filter((file) => /(?:^|\/)(?:\.turbo|node_modules|dist)\//.test(file))).toEqual([])
  })

  it("guard each folder the stylesheet scans, or list it as unguarded, and no other", () => {
    const named = [...frontendUtilities, ...unguardedFolders].map(({ folder }) => folder)
    expect(scanned.map(packageOf).toSorted()).toEqual(named.toSorted())
  })

  it.each(frontendUtilities)(
    "keep $folder's utility out of every scanned file outside it",
    ({ folder, utility }) => {
      const outside = files.filter((file) => !file.startsWith(folder) && holds(file, utility))
      expect(outside).toEqual([])
    },
  )

  it.each(frontendUtilities)(
    "find $folder's utility in a file of the folder",
    ({ folder, utility }) => {
      expect(files.some((file) => file.startsWith(folder) && holds(file, utility))).toBe(true)
    },
  )

  it("read every stylesheet the UI's sheet imports, the packages' and the libraries' among them", () => {
    expect(sheets).toContain(sheet)
    expect(sheets).toContain("frontend/terminal-views/src/terminal-xterm.css")
    expect(sheets.some((file) => file.startsWith("frontend/toolkit/"))).toBe(true)
    expect(sheets.some((file) => file.startsWith("libraries/viewers/"))).toBe(true)
    expect(sheets.some((file) => file.includes("/node_modules/allotment/"))).toBe(true)
  })

  it("let no stylesheet make a guard's class whatever is scanned", () => {
    const made = sheets.flatMap((file) => {
      const text = readFileSync(join(root, file), "utf8")
      return [...inlinedGuards(text), ...ruledGuards(text)].map((utility) => `${file}: ${utility}`)
    })
    expect(made).toEqual([])
  })

  it("find a guard a sheet makes by `@source inline(...)` or by a rule", () => {
    const [demo, toolkit] = [
      frontendUtilities.find(({ folder }) => folder === "frontend/demo/")!.utility,
      frontendUtilities.find(({ folder }) => folder === "frontend/toolkit/")!.utility,
    ]
    expect(inlinedGuards(`@source inline("flex ${demo}");`)).toEqual([demo])
    expect(
      inlinedGuards(`@source inline("{hover:,}${demo.slice(0, 5)}{${demo.slice(5)},x}");`),
    ).toEqual([demo])
    expect(inlinedGuards(`@source not inline("${demo}");`)).toEqual([])
    expect(ruledGuards(`.${demo}{text-decoration-line:underline}`)).toEqual([demo])
    // Hand-written, as a stylesheet escapes it; built from the guard, which no file writes whole.
    expect(ruledGuards(`.${toolkit.replace(/[[\]]/g, "\\$&")} { cursor: inherit }`)).toEqual([
      toolkit,
    ])
    expect(ruledGuards(`.${demo}-offset-2{}`)).toEqual([])
  })
})
