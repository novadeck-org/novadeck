import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs"
import { dirname, join, posix } from "node:path"

// `node scripts/core/move.ts`: moves the UI's model into `application/ui/src/core/`, with the
// files that go with it, and points every importer at the new place. It works out what to do
// from the tree it finds, so it runs again on a fresh main. See scripts/core/README.md.

const root = join(import.meta.dirname, "..", "..")
const ui = "application/ui/src"
const core = `${ui}/core`

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })

if (git("status", "--porcelain").trim() !== "") {
  console.error("The working tree isn't clean: commit or discard its changes first.")
  process.exit(1)
}
if (existsSync(join(root, core))) {
  console.error(`${core} already exists: the move is done. Reset to main to run it again.`)
  process.exit(1)
}

try {
  execFileSync("pnpm", ["exec", "oxfmt", "--version"], { cwd: root, stdio: "ignore" })
} catch {
  console.error("oxfmt can't run here (pnpm install?), and the move formats what it changes.")
  process.exit(1)
}

const tracked = git("ls-files", "-z").split("\0").filter(Boolean)
const trackedSet = new Set(tracked)

// Everything that moves, as old path -> new path, from the repository root.
const moves = new Map<string, string>()
for (const file of tracked)
  if (file.startsWith(`${ui}/model/`))
    moves.set(file, `${core}/${file.slice(`${ui}/model/`.length)}`)
// The pieces the backends share, which the core holds.
for (const name of ["registry", "portable-card-raised"])
  for (const suffix of ["ts", "test.ts"]) {
    const file = `${ui}/backend/${name}.${suffix}`
    if (trackedSet.has(file)) moves.set(file, `${core}/${name}.${suffix}`)
  }
// The boot rehearsal is the demo's debug panel's alone.
for (const suffix of ["ts", "test.ts"]) {
  const file = `${ui}/backend/boot-rehearsal.${suffix}`
  if (trackedSet.has(file)) moves.set(file, `${ui}/backend/demo/debug/boot-rehearsal.${suffix}`)
}
for (const [from, to] of moves) {
  if (trackedSet.has(to)) throw new Error(`${from} would land on ${to}, which is there already.`)
  // `#core/*` maps to `.ts` files.
  if (to.startsWith(`${core}/`) && !to.endsWith(".ts"))
    throw new Error(`${to}: the core holds only .ts files, as the #core/* mapping says.`)
}
if (moves.size === 0) throw new Error("Nothing to move: there is no model/ here.")

const destination = (file: string): string => moves.get(file) ?? file
const inCore = (file: string): boolean => file.startsWith(`${core}/`)

// What the script can't write for the core goes here and stops the run before it changes
// anything: a person decides.
const problems: string[] = []

// A relative specifier names a file as written: with its extension, without one, as `.js`
// for the `.ts` file, or by the folder's index. The form says how, so the new specifier is
// written the same way.
type Named = { file: string; form: "exact" | "extension" | "js" | "index"; ending: string }
const resolve = (from: string, specifier: string): Named | undefined => {
  const bare = specifier.replace(/[?#].*$/, "")
  const target = posix.normalize(posix.join(posix.dirname(from), bare))
  if (trackedSet.has(target)) return { file: target, form: "exact", ending: "" }
  for (const ending of [".ts", ".tsx"])
    if (trackedSet.has(`${target}${ending}`))
      return { file: `${target}${ending}`, form: "extension", ending }
  const js = /\.(?:js|mjs|cjs)$/.exec(target)?.[0]
  if (js)
    for (const ending of [".ts", ".tsx", ".mts"])
      if (trackedSet.has(target.slice(0, -js.length) + ending))
        return { file: target.slice(0, -js.length) + ending, form: "js", ending: js }
  for (const ending of ["/index.ts", "/index.tsx"])
    if (trackedSet.has(`${target}${ending}`))
      return { file: `${target}${ending}`, form: "index", ending }
  return undefined
}
const withoutExtension = (file: string): string => file.replace(/\.(?:ts|tsx|mts)$/, "")

// Every quoted relative path, whatever carries it. Only the module forms are rewritten: what
// stands before the quote says which. A quoted path to a moved file in any other place (a
// `readFileSync`, say) is no module specifier, and the run stops for a person to look.
const literal = /(["'`])(\.{1,2}\/[^"'`\n]*)\1/g
const moduleCalls = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"])
const formOf = (before: string): string | undefined => {
  if (/\bfrom\s*$/.test(before)) return "from"
  if (/\bimport\s*\(\s*$/.test(before)) return "import()"
  if (/\bimport\s*$/.test(before)) return "import"
  if (/\bimport\.meta\.resolve\s*\(\s*$/.test(before)) return "import.meta.resolve()"
  if (/\bnew\s+URL\s*\(\s*$/.test(before)) return "new URL()"
  const call = /\b(\w+)\s*\(\s*$/.exec(before)?.[1]
  return call && moduleCalls.has(call) ? `${call}()` : undefined
}

// A pattern that reaches files (a glob, a template import) can't be followed through the
// move, but it may survive it: it does when every file it reaches keeps its place relative to
// the file that holds it. Anything else stops the run.
const relation = (file: string, other: string): string => posix.relative(posix.dirname(file), other)
const survives = (file: string, pattern: string, extensions: boolean): boolean => {
  const target = posix.normalize(posix.join(posix.dirname(file), pattern))
  return tracked
    .filter((each) =>
      [
        each,
        ...(extensions ? [withoutExtension(each), each.replace(/\/index\.tsx?$/, "")] : []),
      ].some((name) => posix.matchesGlob(name, target)),
    )
    .every((each) => relation(file, each) === relation(destination(file), destination(each)))
}
const globCall =
  /\bimport\.meta\.glob\w*\s*(?:<[^>()]*>)?\s*\(\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|`[^`]*`)/g
const quoted = /(["'`])([^"'`]*)\1/g
const patterns = [
  {
    name: "template import",
    extensions: true,
    pattern: /\bimport\s*\(\s*`(\.{1,2}\/[^`]*\$\{[^`]*)`/g,
    globs: (match: string): string[] => [match.replaceAll(/\$\{[^}]*\}/g, "*")],
  },
  {
    name: "import.meta.glob",
    extensions: false,
    pattern: globCall,
    globs: (match: string): string[] =>
      [...match.matchAll(quoted)].map((each) => each[2]!).filter((glob) => /^\.{1,2}\//.test(glob)),
  },
]

const forms = new Map<string, number>()
const rewrites = new Map<string, string>()
const sourceFile = /\.(?:ts|tsx|mts|cts)$/

for (const file of tracked) {
  if (!sourceFile.test(file) || file.includes("node_modules/")) continue
  const text = readFileSync(join(root, file), "utf8")
  const to = destination(file)
  for (const { name, extensions, pattern, globs } of patterns)
    for (const match of text.matchAll(pattern))
      for (const glob of globs(match[1]!))
        if (!survives(file, glob, extensions))
          problems.push(`${file}: a ${name} reaches the moved files: ${glob}`)
  let changed = false
  const next = text.replace(literal, (whole, quote: string, specifier: string, offset: number) => {
    const target = resolve(file, specifier)
    if (!target) return whole
    const targetTo = destination(target.file)
    if (targetTo === target.file && to === file) return whole
    const query = /[?#].*$/.exec(specifier)?.[0] ?? ""
    const form = formOf(text.slice(Math.max(0, offset - 40), offset))
    if (form === undefined) {
      problems.push(`${file}: ${whole} names a moved file, but not as a module specifier`)
      return whole
    }
    const viaCore =
      inCore(targetTo) && to.startsWith(`${ui}/`) && !inCore(to) && form !== "new URL()"
    let written: string
    if (viaCore) {
      // The package's own `imports`, which step 5 turns into the core package's name. Its
      // mapping serves `.ts` files by their extensionless name, and nothing else.
      if (target.form === "index" || query !== "") {
        problems.push(`${file}: ${whole} can't be written as #core/*`)
        return whole
      }
      written = `#core/${withoutExtension(targetTo).slice(core.length + 1)}`
    } else {
      const place =
        target.form === "exact"
          ? targetTo
          : target.form === "index"
            ? posix.dirname(targetTo)
            : target.form === "js"
              ? withoutExtension(targetTo) + target.ending
              : withoutExtension(targetTo)
      const relative = posix.relative(posix.dirname(to), place)
      written = relative.startsWith(".") ? relative : `./${relative}`
    }
    if (`${written}${query}` === specifier) return whole
    forms.set(form, (forms.get(form) ?? 0) + 1)
    changed = true
    return `${quote}${written}${query}${quote}`
  })
  if (changed) rewrites.set(file, next)
}

// Paths written out in full in scripts, docs and tests, built from what moves: the moved
// files, and the folders that move whole. Anchored at the UI's folder (`application/ui/src/`,
// or `ui/src/` where the text is relative to application/), with a right boundary, so a
// same-named path in another package, or `registry.tsx`, is left alone.
const uiPath = (path: string): string => path.slice(path.indexOf("ui/src/"))
// The folders that move whole, with where they go.
const trackedIn = (dir: string): string[] => tracked.filter((file) => file.startsWith(`${dir}/`))
const wholeFolders = [...new Set([...moves.keys()].map((file) => posix.dirname(file)))]
  .filter((dir) => trackedIn(dir).every((file) => moves.has(file)))
  .map((dir) => {
    const places = new Set(
      tracked
        .filter((file) => posix.dirname(file) === dir)
        .map((file) => posix.dirname(destination(file))),
    )
    return [dir, places] as const
  })
  .filter(([, places]) => places.size === 1)
  .map(([dir, places]) => [`${dir}/`, `${[...places][0]!}/`] as const)
const textual = [
  ...[...moves].map(([from, to]) => [from, to, true] as const),
  ...wholeFolders.map(([from, to]) => [from, to, false] as const),
]
  .map(([from, to, file]) => [uiPath(from), uiPath(to), file] as const)
  .toSorted((a, b) => b[0].length - a[0].length)
// How a path reads in a file: plainly, or escaped for a regular expression (`ui\/src\/a\.ts`).
const written = (path: string, regexp: boolean): string =>
  regexp ? path.replaceAll(".", "\\.").replaceAll("/", "\\/") : path
const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
const anchored = (path: string, file: boolean, regexp: boolean): RegExp => {
  const rest = escapeRegExp(written(path.slice("ui/src/".length), regexp))
  const full = escapeRegExp(written("application/ui/src/", regexp))
  const bare = escapeRegExp(written("ui/src/", regexp))
  const right = file ? "(?![\\w-]|\\.\\w)" : ""
  return new RegExp(`(?:(?<![\\w.-])${full}|(?<![\\w./-])${bare})${rest}${right}`, "g")
}
const ignored =
  /(?:^|\/)(?:pnpm-lock\.yaml|node_modules|scripts\/core\/)|\.(?:png|jpe?g|webp|ico|woff2?|zip)$/

const moved = new Set(moves.keys())
const touched = new Set<string>()
const outside = (file: string): boolean =>
  !ignored.test(file) && !moved.has(file) && !file.startsWith(`${ui}/`)
for (const file of tracked.filter(outside)) {
  const text = rewrites.get(file) ?? readFileSync(join(root, file), "utf8")
  let next = text
  for (const [from, to, isFile] of textual)
    for (const regexp of [false, true])
      next = next.replaceAll(anchored(from, isFile, regexp), (whole) => {
        const prefix = whole.startsWith("application") ? "application/ui/src/" : "ui/src/"
        return written(prefix + to.slice("ui/src/".length), regexp)
      })
  if (next !== text) rewrites.set(file, next)
}

if (problems.length > 0) {
  console.error(`Nothing was changed. Look at these first:\n${problems.join("\n")}`)
  process.exit(1)
}

// Rewrite in place at the old paths, move, then settle each file's text at its new path.
for (const [file, text] of rewrites) writeFileSync(join(root, file), text)
for (const [from, to] of moves) {
  mkdirSync(join(root, dirname(to)), { recursive: true })
  git("mv", from, to)
}
// Folders the move emptied of tracked files go, if nothing else is in them.
for (const dir of [...new Set([...moves.keys()].map((file) => posix.dirname(file)))]
  .toSorted()
  .toReversed())
  for (let each = dir; each.startsWith(`${ui}/`) && each !== ui; each = posix.dirname(each)) {
    try {
      rmdirSync(join(root, each))
    } catch {
      break
    }
  }
for (const file of rewrites.keys()) touched.add(destination(file))
for (const file of moves.values()) touched.add(file)

execFileSync("pnpm", ["exec", "oxfmt", ...touched], { cwd: root, stdio: "inherit" })

const count = (prefix: string): number =>
  [...moves.values()].filter((to) => to.startsWith(prefix)).length
console.log(
  `moved ${moves.size} files (${count(`${core}/`)} into core/, ${count(`${ui}/backend/demo/`)} into the demo's debug/);` +
    ` rewrote ${rewrites.size} files.`,
)
console.log(
  `specifiers by form: ${[...forms].map(([form, n]) => `${form} ${n}`).join(", ") || "none"}`,
)
// What still names a moved path, outside the UI's source, is for a person to look at.
let found = ""
const old = [...moves.keys()].map((file) => file.slice(file.indexOf("src/")))
const needles = [
  ...new Set([...old, ...wholeFolders.map(([dir]) => dir.slice(dir.indexOf("src/"))), "ui/model"]),
]
try {
  found = git(
    "grep",
    "-nF",
    ...needles.flatMap((needle) => ["-e", needle]),
    "--",
    ".",
    ":!scripts/core",
    ":!pnpm-lock.yaml",
  )
} catch {
  // No match is the good case.
}
const leftovers = found.split("\n").filter(Boolean)
if (leftovers.length > 0)
  console.warn(`look at these mentions of the old folder:\n${leftovers.join("\n")}`)
console.log("Next: pnpm typecheck && pnpm lint && pnpm test (see scripts/core/README.md).")
