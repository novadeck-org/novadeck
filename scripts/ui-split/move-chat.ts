import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { finish, isText, preflight, repository } from "../packages/move.ts"
import {
  chatDir,
  destinationOf,
  importedKeys,
  insertAfter,
  missingExports,
  rewriteSpecifiers,
} from "./chat.ts"

// `node scripts/ui-split/move-chat.ts`: PR 3c of the UI split. Moves the chat view
// (`terminals/chat/`: sources, tests and chat.css) into `frontend/chat`, points every import
// that names a moved file at `@novadeck/chat/<module>`, and adds the package to the UI's
// styles.css. It makes the tree so rather than doing a move: run again, it moves what a branch
// added at the old place and rewrites what it added that names one, and on a tree with nothing
// to do it changes nothing. The package's own files (manifest, configs, README, the one-line
// test.ts), the UI's and chat-contract's manifests, chat-contract's one import of
// `@novadeck/ui/terminals/chat/Transcript` (now `@novadeck/chat/Transcript`) and the checks that
// follow the move (architecture test, graph test, theme tests, docs) are committed by hand, not
// written here. A branch that predates the
// toolkit or companion moves is handled: a chat file naming `ui-toolkit/` or `../companion/` is
// pointed at that package, so those scripts may run before or after this one.

const root = join(import.meta.dirname, "..", "..")
const { git, read, tracked } = repository(root)
const oxfmt = preflight(root, [])

const styles = "frontend/ui/src/styles.css"

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

// The importers, and the moved files themselves: every specifier that names a moved file.
for (const file of files) {
  if (!isText(file) || !/\.(?:[cm]?[jt]sx?|css)$/.test(file)) continue
  if (!file.startsWith("frontend/") && !file.startsWith("apps/") && !file.startsWith("tools/"))
    continue
  const { text: next, problems: found } = rewriteSpecifiers(file, read(file), files)
  problems.push(...found)
  if (next !== read(file)) writes.set(file, next)
}

// The UI's stylesheet: the package scanned (its tests not), after the companion's lines.
if (files.has(styles)) {
  let text = writes.get(styles) ?? read(styles)
  const step = (next: string | undefined, why: string): void => {
    if (next === undefined) problems.push(`${styles}: ${why}`)
    else text = next
  }
  step(
    insertAfter(text, `@source "../../companion/src";`, `@source "../../chat/src";`),
    "no @source line of the companion to put the chat's after",
  )
  step(
    insertAfter(
      text,
      `@source not "../../companion/src/**/*.test.ts";`,
      `@source not "../../chat/src/**/*.test.ts";`,
    ),
    "no @source not line of the companion to put the chat's after",
  )
  if (text !== read(styles) || writes.has(styles)) writes.set(styles, text)
}

// Every module an outsider imports needs its export, or the import can't resolve.
const manifestPath = join(root, chatDir, "package.json")
if (existsSync(manifestPath)) {
  const { exports: exported = {} } = JSON.parse(read(`${chatDir}/package.json`)) as {
    exports?: Record<string, unknown>
  }
  const outside = [...writes].filter(
    ([file]) => !(destinationOf(file) ?? file).startsWith(`${chatDir}/`),
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
