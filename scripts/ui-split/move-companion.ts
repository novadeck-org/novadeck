import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { applyEdit, type Edit } from "../packages/move.ts"
import { finish, isText, preflight, repository } from "../packages/move.ts"
import {
  companionDir,
  companionName,
  destinationOf,
  importedKeys,
  insertAfter,
  missingExports,
  rewriteSpecifiers,
} from "./companion.ts"

// `node scripts/ui-split/move-companion.ts`: PR 1a of the UI split. Moves the companion pane
// (`terminals/companion/`) and the bar drag it shares with the views (`terminals/drag-session.ts`
// with its test) into `frontend/companion`, points every import that names a moved file at
// `@novadeck/companion/<module>`, and adds the package to the UI's styles.css. It makes the tree
// so rather than doing a move: run again, it moves what a branch added at an old place and
// rewrites what it added that names one, and on a tree with nothing to do it changes nothing.
// The package's own files (manifest, configs, README, the one-line test.ts) and the checks that
// follow the move (architecture test, graph test, docs) are committed by hand, not written here.

const root = join(import.meta.dirname, "..", "..")
const { git, read, tracked } = repository(root)
const oxfmt = preflight(root, [])

const styles = "frontend/ui/src/styles.css"
const terminalCompanion = "frontend/ui/src/terminals/companion/TerminalCompanion.tsx"

const problems: string[] = []
const writes = new Map<string, string>()
const moves: { from: string; to: string }[] = []
const files = new Set(tracked())

for (const file of files) {
  const to = destinationOf(file)
  if (to) moves.push({ from: file, to })
}
// What a move leaves in place to clash with: the new place holds another file.
for (const { to } of moves) if (files.has(to)) problems.push(`${to} is there already`)

// By-hand edits a rewrite can't make, made before it: the pane named the window's controls
// (`TerminalLayoutControls["onReveal"]`, WindowShell.tsx) only for the type of one callback, and
// a package can't reach the window. It declares the callback's type itself.
const revealType = `// How far the pane reaches into its window, as the window wants to know when it opens.
type Reveal = (extent: { readonly right: number; readonly height: number }) => void
`
const edits: Edit[] = [
  {
    file: terminalCompanion,
    before: `import type { TerminalLayoutControls } from "../WindowShell"\n`,
    after: "",
    why: "the window's controls stay in the UI",
  },
  {
    file: terminalCompanion,
    before: `  onReveal: TerminalLayoutControls["onReveal"]\n`,
    after: `  onReveal: Reveal | undefined\n`,
    why: "the callback's type is the package's own",
  },
  {
    file: terminalCompanion,
    before: `  onReveal?: TerminalLayoutControls["onReveal"]\n`,
    after: `  onReveal?: Reveal | undefined\n`,
    why: "the callback's type is the package's own",
  },
]
const edit = (file: string, text: string): string => {
  let next = text
  for (const each of edits) {
    if (each.file !== file && destinationOf(each.file) !== file) continue
    const done = applyEdit(next, each)
    if ("problem" in done) problems.push(done.problem)
    else next = done.text
  }
  if (file === terminalCompanion || file === destinationOf(terminalCompanion)) {
    const anchor = "const unnamed = (): undefined => undefined"
    const made = next.includes("type Reveal =")
      ? next
      : next.includes(anchor)
        ? next.replace(anchor, `${revealType}\n${anchor}`)
        : undefined
    if (made === undefined) problems.push(`${file}: no "${anchor}" to put the Reveal type before`)
    else next = made
  }
  return next
}

// The importers, and the moved files themselves: every specifier that names a moved file.
for (const file of files) {
  if (!isText(file) || !/\.(?:[cm]?[jt]sx?|css)$/.test(file)) continue
  if (!file.startsWith("frontend/") && !file.startsWith("apps/") && !file.startsWith("tools/"))
    continue
  const text = edit(file, read(file))
  const { text: next, problems: found } = rewriteSpecifiers(file, text, files)
  problems.push(...found)
  if (next !== read(file)) writes.set(file, next)
}

// The UI's stylesheet: the package scanned (its tests not), after the toolkit's lines.
if (files.has(styles)) {
  let text = writes.get(styles) ?? read(styles)
  const step = (next: string | undefined, why: string): void => {
    if (next === undefined) problems.push(`${styles}: ${why}`)
    else text = next
  }
  step(
    insertAfter(text, `@source "../../toolkit/src";`, `@source "../../companion/src";`),
    "no @source line of the toolkit to put the companion's after",
  )
  step(
    insertAfter(
      text,
      `@source not "../../toolkit/src/**/*.test.ts";`,
      `@source not "../../companion/src/**/*.test.ts";`,
    ),
    "no @source not line of the toolkit to put the companion's after",
  )
  if (text !== read(styles) || writes.has(styles)) writes.set(styles, text)
}

// Every module an outsider imports needs its export, or the import can't resolve.
const manifestPath = join(root, companionDir, "package.json")
if (existsSync(manifestPath)) {
  const { exports: exported = {} } = JSON.parse(read(`${companionDir}/package.json`)) as {
    exports?: Record<string, unknown>
  }
  const outside = [...writes].filter(
    ([file]) => !(destinationOf(file) ?? file).startsWith(`${companionDir}/`),
  )
  problems.push(
    ...missingExports(
      importedKeys(outside.map(([, text]) => text)),
      new Set(Object.keys(exported)),
    ),
  )
}

if (problems.length > 0) {
  console.error(`Stopped, nothing changed. Decide these first:\n${problems.join("\n")}`)
  process.exit(1)
}

try {
  for (const { from, to } of moves) {
    mkdirSync(join(root, dirname(to)), { recursive: true })
    git("mv", from, to)
  }
  // A moved file's rewritten text goes to its new place.
  const written: string[] = []
  for (const [file, text] of writes) {
    const place = destinationOf(file) ?? file
    mkdirSync(join(root, dirname(place)), { recursive: true })
    writeFileSync(join(root, place), text)
    written.push(place)
  }
  // The install and the format are for a run that changed something.
  if (moves.length + writes.size > 0) finish(root, oxfmt, written)
  const staged = new Set([...written, ...moves.map(({ to }) => to)])
  if (staged.size > 0) git("add", "--", ...staged)
} catch (error) {
  console.error(
    `The move stopped partway: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\nThe tree is half moved: \`git reset --hard\`, then run the script again.`,
  )
  process.exit(1)
}

console.log(
  moves.length + writes.size === 0
    ? "Nothing to do: the tree is as the move leaves it."
    : `Moved ${moves.length} files and wrote ${writes.size} that the move changes.`,
)
