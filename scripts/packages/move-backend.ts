import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { destinationOf, edits, leftovers, rewritable, rewrite, rows } from "./backend.ts"
import {
  applyEdit,
  carry,
  finish,
  outsideWorkspace,
  preflight,
  repository,
  trackedIgnored,
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

// Build output tracked by mistake, which would move into a folder that ignores it.
for (const file of trackedIgnored(root, [...files.filter(destinationOf), ...placeOf.values()]))
  problems.push(
    `${file} is tracked, but its package ignores it as build output: git rm --cached it`,
  )
for (const place of outsideWorkspace(
  root,
  rows.map(({ to }) => to),
))
  problems.push(`pnpm-workspace.yaml takes in no ${place}: add its folder's glob first`)

// On a branch that merged the move from main: a file the branch had removed or renamed at an
// old place, which the merge brought back at its new one from main's side.
const has = (commit: string, file: string): boolean => {
  try {
    git("cat-file", "-e", `${commit}:${file}`)
    return true
  } catch {
    return false
  }
}
const marker = `${rows[1].from}/package.json`
const markerAfter = `${rows[1].to}/package.json`
const merge = git("rev-list", "--first-parent", "--merges", "-n", "500", "HEAD")
  .split("\n")
  .filter(Boolean)
  .find((commit) => has(`${commit}^1`, marker) && has(`${commit}^2`, markerAfter))
if (merge !== undefined) {
  const base = git("merge-base", `${merge}^1`, `${merge}^2`).trim()
  const removed = git(
    "diff",
    "--name-status",
    "-M",
    "--diff-filter=DR",
    base,
    `${merge}^1`,
    "--",
    ...olds,
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1]!)
  for (const file of removed) {
    const back = destinationOf(file)
    if (back !== undefined && present.has(back))
      problems.push(
        `${back} came back with main's move, though the branch removed or renamed ${file}: git rm ${back}, if the branch's change stands`,
      )
  }
}

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

// The move, the rewritten texts at their new places, what is left at the old ones, and the
// install, as one piece: a failure in it leaves the tree half moved.
let carried: { carried: string[]; clashes: string[] }
try {
  for (const { from, to } of moves) {
    mkdirSync(join(root, dirname(to)), { recursive: true })
    git("mv", from, to)
  }
  for (const [file, text] of texts) writeFileSync(join(root, file), text)
  carried = carry(root, olds, (file) => destinationOf(file))
  finish(root, oxfmt, [...texts.keys()])
} catch (error) {
  console.error(
    `The move stopped partway: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n` +
      "The tree is half moved. Run `git reset --hard`, delete the new folders where no tracked " +
      "file is (backend/, contract/, tools/atlas), then run the script again.",
  )
  process.exit(1)
}

// What the move leaves: mentions of an old folder in a form the rewrite doesn't read.
const left = tracked().flatMap((file) => (rewritable(file) ? leftovers(file, read(file)) : []))

console.log(
  moves.length === 0 && texts.size === 0 && carried.carried.length === 0
    ? "Nothing to do: the tree is as the move leaves it."
    : `Moved ${moves.length} files and rewrote ${texts.size} that named a moved folder.`,
)
if (carried.carried.length > 0)
  console.log(`Carried what git doesn't track to the new places:\n${carried.carried.join("\n")}`)
if (skipped.length > 0)
  console.log(`Handwritten edits with nothing to do, for a person to check:\n${skipped.join("\n")}`)
if (carried.clashes.length > 0)
  console.error(
    `Left at an old place, as the new one holds another file: decide which stands.\n${carried.clashes.join("\n")}`,
  )
if (left.length > 0)
  console.error(`Mentions of a moved folder the rewrite didn't reach:\n${left.join("\n")}`)
if (carried.clashes.length > 0 || left.length > 0) process.exit(1)
