import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { destinationOf, edits, leftovers, rewritable, rewrite, rows } from "./backend.ts"
import { applyEdit, finish, preflight, repository } from "./move.ts"

// `node scripts/packages/move-backend.ts`: step 5's 5.3a. Moves the runner, the relay, the
// protocol, the runner client and the atlas into backend/, contract/ and tools/, and points
// every mention of them at the new place. It makes the tree so rather than doing a move: run
// again, it moves what a branch added at an old place and rewrites what it added that names
// one, and on a tree with nothing to do it changes nothing. See scripts/packages/README.md.

const root = join(import.meta.dirname, "..", "..")
const { git, read, tracked } = repository(root)
const oxfmt = preflight(root)

// The plan, made whole before anything is written.
const files = tracked()
const present = new Set(files)
const problems: string[] = []
const moves = files.flatMap((file) => {
  const to = destinationOf(file)
  if (to === undefined) return []
  if (present.has(to)) {
    problems.push(`${file} and ${to} are both tracked: keep one, at ${to}`)
    return []
  }
  return [{ from: file, to }]
})
const placeOf = new Map(moves.map(({ from, to }) => [from, to]))

const texts = new Map<string, string>()
for (const file of files) {
  const place = placeOf.get(file) ?? file
  if (!rewritable(place)) continue
  const text = read(file)
  const next = rewrite(text)
  if (next !== text) texts.set(place, next)
}
for (const edit of edits) {
  const original = files.find((file) => (placeOf.get(file) ?? file) === edit.file)
  // A later step moved it, and its own move rewrote what this edit names.
  if (original === undefined) continue
  const made = applyEdit(texts.get(edit.file) ?? read(original), edit)
  if ("problem" in made) problems.push(made.problem)
  else if (made.text !== read(original) || texts.has(edit.file)) texts.set(edit.file, made.text)
}

if (problems.length > 0) {
  console.error(`Stopped, nothing changed. Decide these first:\n${problems.join("\n")}`)
  process.exit(1)
}

// The move, then the rewritten texts at their new places.
for (const { from, to } of moves) {
  mkdirSync(join(root, dirname(to)), { recursive: true })
  git("mv", from, to)
}
for (const [file, text] of texts) writeFileSync(join(root, file), text)

// What the move leaves: mentions of an old folder in a form the rewrite doesn't read.
const changed = moves.length > 0 || texts.size > 0
finish({ root, oxfmt, written: [...texts.keys()], changed, folders: rows.map(({ from }) => from) })
const left = tracked().flatMap((file) => (rewritable(file) ? leftovers(file, read(file)) : []))

console.log(
  !changed
    ? "Nothing to do: the tree is as the move leaves it."
    : `Moved ${moves.length} files and rewrote ${texts.size} that named a moved folder.`,
)
if (left.length > 0) {
  console.error(`Mentions of a moved folder the rewrite didn't reach:\n${left.join("\n")}`)
  process.exit(1)
}
