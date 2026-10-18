import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, posix } from "node:path"

// `node scripts/core/move-port.ts`: moves the backend port, `application/ui/src/backend/port.ts`,
// into the core as `core/port.ts`, and points every importer at `#core/port`. It works out what
// to do from the tree it finds, so it runs again after other pull requests change the port or
// its importers. See scripts/core/README.md.

const root = join(import.meta.dirname, "..", "..")
const ui = "application/ui/src"
const from = `${ui}/backend/port.ts`
const to = `${ui}/core/port.ts`

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })

if (git("status", "--porcelain").trim() !== "") {
  console.error("The working tree isn't clean: commit or discard its changes first.")
  process.exit(1)
}
if (existsSync(join(root, to))) {
  console.error(
    `${to} already exists: the move is done. Reset to the branch's base to run it again.`,
  )
  process.exit(1)
}
if (!existsSync(join(root, from))) {
  console.error(`There is no ${from} to move.`)
  process.exit(1)
}
try {
  execFileSync("pnpm", ["exec", "oxfmt", "--version"], { cwd: root, stdio: "ignore" })
} catch {
  console.error("oxfmt can't run here (pnpm install?), and the move formats what it changes.")
  process.exit(1)
}

const tracked = new Set(git("ls-files", "-z").split("\0").filter(Boolean))

// A quoted specifier where it names a module: `from`, a bare `import`, `import()`, and the
// test runner's module calls. The quote and the specifier are captured.
const specifiers =
  /(\bfrom\s*|^\s*import\s*|\bimport\(\s*|\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\(\s*)(["'])([^"'\n]+)\2/gm

// Whether a relative specifier in `file` names the port, written with or without its `.ts`.
const namesPort = (file: string, specifier: string): boolean => {
  if (!specifier.startsWith(".")) return false
  const target = posix.normalize(posix.join(posix.dirname(file), specifier.replace(/[?#].*$/, "")))
  return target === from || `${target}.ts` === from || target.replace(/\.js$/, ".ts") === from
}

// What the script can't write goes here and stops the run before it changes anything.
const problems: string[] = []
const rewrites = new Map<string, string>()

for (const file of tracked) {
  if (!/\.(?:ts|tsx|mts)$/.test(file) || file === from) continue
  const text = readFileSync(join(root, file), "utf8")
  if (!text.includes("port")) continue
  const next = text.replace(specifiers, (whole, lead: string, quote: string, specifier: string) => {
    if (!namesPort(file, specifier)) return whole
    if (/[?#]/.test(specifier)) {
      problems.push(`${file}: ${specifier} carries a query, which #core/* can't`)
      return whole
    }
    // The rest of the UI imports the core by `#core/*`; the core's own files, and anything
    // outside the UI's sources, by a relative path to the new place, ending as the old one
    // did (`.ts`, `.js` or none).
    if (file.startsWith(`${ui}/`) && !file.startsWith(`${ui}/core/`))
      return `${lead}${quote}#core/port${quote}`
    const ending = /\.(?:ts|js)$/.exec(specifier)?.[0] ?? ""
    let relative = posix.relative(posix.dirname(file), to.replace(/\.ts$/, ending))
    if (!relative.startsWith(".")) relative = `./${relative}`
    return `${lead}${quote}${relative}${quote}`
  })
  // A path to the port read as a file, or resolved as a URL, is for a person to decide; the
  // rules and docs that name it as text are left to the docs commit, listed at the end.
  for (const line of next.split("\n"))
    if (/(?:readFileSync|readFile|new URL|resolve)\([^)]*backend\/port/.test(line))
      problems.push(`${file}: ${line.trim()}`)
  if (next !== text) rewrites.set(file, next)
}

// The port's own imports of the core become relative, as it now sits beside them. A relative
// import it has already names a place beside `backend/`, which the move would change.
const original = readFileSync(join(root, from), "utf8")
if (/(?:\bfrom\s*|\bimport\(\s*)["']\.\.?\//.test(original))
  problems.push(`${from} imports something by a relative path, which the move would break`)
const port = original.replace(
  /(["'])#core\/([^"']+)\1/g,
  (_whole, quote: string, path: string) => `${quote}./${path}${quote}`,
)

if (problems.length > 0) {
  console.error(`Stopped, nothing changed. Decide these first:\n${problems.join("\n")}`)
  process.exit(1)
}

git("mv", from, to)
writeFileSync(join(root, to), port)
for (const [file, text] of rewrites) writeFileSync(join(root, file), text)
execFileSync("pnpm", ["exec", "oxfmt", to, ...rewrites.keys()], { cwd: root, stdio: "inherit" })

// Mentions of the old path the script leaves to the docs commit: prose, tables, anchors.
let left = ""
try {
  left = git("grep", "-n", "backend/port", "--", ".", ":!pnpm-lock.yaml").trim()
} catch {
  // git grep finds nothing: no mention left.
}
console.log(`Moved ${from} to ${to}, and rewrote ${rewrites.size} importers.`)
if (left) console.log(`Mentions of the old path left for the docs:\n${left}`)
