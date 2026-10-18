import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { destinationOf, edits, leftovers, rewritable, rewrite, rows } from "./backend.ts"
import {
  applyEdit,
  carry,
  finish,
  ignoredPlaces,
  outsideWorkspace,
  preflight,
  repository,
  undoneByMerge,
} from "./move.ts"

// `node scripts/packages/move-backend.ts`: step 5's 5.3a. Moves the runner, the relay, the
// protocol, the runner client and the atlas into backend/, contract/ and tools/, and points
// every mention of them at the new place. It makes the tree so rather than doing a move: run
// again, it moves what a branch added at an old place and rewrites what it added that names
// one, and on a tree with nothing to do it changes nothing. See scripts/packages/README.md.

const root = join(import.meta.dirname, "..", "..")
const { git, read, tracked } = repository(root)
const olds = rows.map(({ from }) => from)
const oxfmt = preflight(root, olds)

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
const sourceOf = new Map(moves.map(({ from, to }) => [to, from]))

// Build output tracked by mistake, which would move into a folder that ignores it.
for (const place of ignoredPlaces(root, [...placeOf.keys(), ...placeOf.values()])) {
  const file = sourceOf.get(place) ?? place
  problems.push(
    `${file} is tracked, but its package ignores it as build output: git rm --cached ${file}`,
  )
}
for (const place of outsideWorkspace(
  root,
  rows.map(({ to }) => to),
))
  problems.push(`pnpm-workspace.yaml takes in no ${place}: add its folder's glob first`)

for (const { back, file, renamed } of undoneByMerge({
  root,
  marker: { from: `${rows[1].from}/package.json`, to: `${rows[1].to}/package.json` },
  olds,
  destinationOf,
}))
  problems.push(
    renamed
      ? `${back} came back with main's move beside ${renamed}, the branch's rename of ${file}: git rm the one that doesn't stand, and commit`
      : `${back} came back with main's move, though the branch deleted ${file}: git rm it if the deletion stands, or commit anything (an empty commit says so) to keep it`,
  )

const texts = new Map<string, string>()
for (const file of files) {
  const place = placeOf.get(file) ?? file
  if (!rewritable(place)) continue
  const text = read(file)
  const next = rewrite(text)
  if (next !== text) texts.set(place, next)
}
const skipped: string[] = []
for (const edit of edits) {
  const original = files.find((file) => (placeOf.get(file) ?? file) === edit.file)
  // A later step moved it, and its own move rewrote what this edit names.
  if (original === undefined) {
    skipped.push(`${edit.file} is gone: ${edit.why}`)
    continue
  }
  const made = applyEdit(texts.get(edit.file) ?? read(original), edit)
  if ("problem" in made) problems.push(made.problem)
  else if (made.state === "made") texts.set(edit.file, made.text)
  else if (made.state === "gone") skipped.push(`${edit.file}, whose line changed: ${edit.why}`)
}

if (problems.length > 0) {
  console.error(`Stopped, nothing changed. Decide these first:\n${problems.join("\n")}`)
  process.exit(1)
}

// The move, the rewritten texts at their new places and the install, as one piece: a
// failure in it leaves the tree half moved, with nothing outside git's reach touched yet.
try {
  for (const { from, to } of moves) {
    mkdirSync(join(root, dirname(to)), { recursive: true })
    git("mv", from, to)
  }
  for (const [file, text] of texts) writeFileSync(join(root, file), text)
  finish(root, oxfmt, [...texts.keys()])
} catch (error) {
  console.error(
    `The move stopped partway: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n` +
      "The tree is half moved, and nothing git doesn't track has moved yet. Run `git reset --hard`, " +
      "delete the new folders (backend/, contract/, tools/atlas), then run the script again.",
  )
  process.exit(1)
}

// Last, what git doesn't track at the old places, rewritten where it is text: a branch's
// work in progress names old paths as its tracked files did.
let carried: ReturnType<typeof carry>
try {
  carried = carry(root, olds, destinationOf)
} catch (error) {
  console.error(
    `Carrying what git doesn't track stopped partway: ${error instanceof Error ? error.message : String(error)}\n` +
      "The move itself is done. Look at what is left at the old places, move it by hand, and run the script again.",
  )
  process.exit(1)
}
const carriedRewritten = carried.carried.filter(({ to }) => {
  if (!rewritable(to)) return false
  const text = read(to)
  const next = rewrite(text)
  if (next === text) return false
  writeFileSync(join(root, to), next)
  return true
})

// What the move leaves: mentions of an old folder in a form the rewrite doesn't read.
const left = tracked().flatMap((file) => (rewritable(file) ? leftovers(file, read(file)) : []))
const lockfile = git("status", "--porcelain", "--", "pnpm-lock.yaml").trim() !== ""

console.log(
  moves.length === 0 && texts.size === 0 && carried.carried.length === 0 && !lockfile
    ? "Nothing to do: the tree is as the move leaves it."
    : `Moved ${moves.length} files and rewrote ${texts.size} that named a moved folder.`,
)
if (lockfile && moves.length === 0) console.log("The install made pnpm-lock.yaml whole: commit it.")
if (carried.carried.length > 0)
  console.log(
    `Carried what git doesn't track to the new places${carriedRewritten.length > 0 ? `, rewriting ${carriedRewritten.length}` : ""}:\n${carried.carried.map(({ from, to }) => `${from} -> ${to}`).join("\n")}`,
  )
if (skipped.length > 0)
  console.log(`Handwritten edits with nothing to do, for a person to check:\n${skipped.join("\n")}`)
if (carried.clashes.length > 0)
  console.error(
    `Left at an old place, as the new one holds another file: decide which stands.\n${carried.clashes.join("\n")}`,
  )
if (left.length > 0)
  console.error(`Mentions of a moved folder the rewrite didn't reach:\n${left.join("\n")}`)
if (carried.clashes.length > 0 || left.length > 0) process.exit(1)
