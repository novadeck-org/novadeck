import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import {
  cleanPaths,
  destinationOf,
  keptFile,
  leftover,
  packages,
  plan,
  rewritePaths,
} from "./frontend.ts"
import { mergeHead, markersIn, resolveMerge } from "./merge-frontend.ts"
import {
  carry,
  finish,
  ignoredPlaces,
  isText,
  outsideWorkspace,
  preflight,
  repository,
  undoneByMerge,
} from "./move.ts"

// `node scripts/packages/move-frontend.ts`: step 5's 5.3b. Splits application/ui into the
// packages of frontend/ and the apps of apps/, points every import and every mention of a moved
// path at the new place, and writes the packages' manifests, configs and tests. It makes the
// tree so rather than doing a move: run again, it moves what a branch added at an old place
// and rewrites what it added that names one, and on a tree with nothing to do it changes
// nothing. See scripts/packages/README.md.

const root = join(import.meta.dirname, "..", "..")
const { git, read, tracked } = repository(root)
const olds = ["application/ui"]

// Run while a merge of main is open on a branch the move already ran on: it resolves the
// files the move writes whole (they are on both sides), and names what is left.
const merging = mergeHead(root)
if (merging) {
  const { done, left } = resolveMerge(root, merging)
  const marked = markersIn(root)
  if (done.length > 0)
    console.log(`Resolved from main's commit that added each:\n${done.join("\n")}`)
  if (left.length > 0) console.error(`Left for a person:\n${left.join("\n")}`)
  if (marked.length > 0)
    console.error(`Conflict markers still in the tree (not to be committed):\n${marked.join("\n")}`)
  console.log(
    left.length + marked.length === 0
      ? "The merge is ready: `git add -u && git commit --no-edit`, then run this again."
      : "Fix those, `git add` them, then run this again.",
  )
  process.exit(left.length + marked.length === 0 ? 0 : 1)
}

const oxfmt = preflight(root, olds)
const markers = markersIn(root)
if (markers.length > 0) {
  console.error(
    `Stopped, nothing changed. Conflict markers are in tracked files (a merge committed unresolved?):\n${markers.slice(0, 20).join("\n")}`,
  )
  process.exit(1)
}

// Where a file below the old UI goes, whatever it is: git doesn't track the ones carry finds.
const placeOf = (file: string): string =>
  destinationOf(file) ?? `frontend/ui/${file.slice("application/ui/".length)}`

const planned = plan({
  tracked: tracked(),
  read,
  isTextual: isText,
  template: (file) => readFileSync(join(import.meta.dirname, "frontend", `${file}.tmpl`), "utf8"),
})
const problems = [...planned.problems]

// Build output tracked by mistake, which would move into a folder that ignores it.
const sourceOf = new Map(planned.moves.map(({ from, to }) => [to, from]))
for (const place of ignoredPlaces(root, [
  ...planned.moves.map(({ from }) => from),
  ...planned.moves.map(({ to }) => to),
])) {
  const file = sourceOf.get(place) ?? place
  problems.push(
    `${file} is tracked, but its package ignores it as build output: git rm --cached ${file}`,
  )
}
for (const place of outsideWorkspace(
  root,
  packages.map(({ dir }) => dir),
))
  problems.push(`pnpm-workspace.yaml takes in no ${place}: add its folder's glob first`)

// What a merge of main's move brought back that the branch had deleted or renamed.
for (const { back, file: old, renamed } of undoneByMerge({
  root,
  marker: { from: "application/ui/package.json", to: "frontend/ui/package.json" },
  olds,
  destinationOf: (file) => {
    const to = destinationOf(file)
    return typeof to === "string" ? to : undefined
  },
}))
  problems.push(
    renamed
      ? `${back} came back with main's move beside ${renamed}, the branch's rename of ${old}: git rm the one that doesn't stand, and commit`
      : `${back} came back with main's move, though the branch deleted ${old}: git rm it if the deletion stands, or commit anything (an empty commit says so) to keep it`,
  )

if (problems.length > 0) {
  console.error(`Stopped, nothing changed. Decide these first:\n${problems.join("\n")}`)
  process.exit(1)
}

// The move, the texts at their new places and the install, as one piece: a failure in it
// leaves the tree half moved, with nothing outside git's reach touched yet.
try {
  for (const { from, to } of planned.moves) {
    mkdirSync(join(root, dirname(to)), { recursive: true })
    git("mv", from, to)
  }
  for (const file of planned.removes) git("rm", "-q", "-f", file)
  for (const [file, text] of planned.writes) {
    mkdirSync(join(root, dirname(file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  finish(root, oxfmt, [...planned.writes.keys()])
} catch (error) {
  console.error(
    `The move stopped partway: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n` +
      "The tree is half moved, and nothing git doesn't track has moved yet. Run " +
      `\`git reset --hard && git clean -fd -- ${cleanPaths([...planned.writes.keys(), ...planned.moves.map(({ to }) => to)]).join(" ")}\`, which keeps what git ignores there, ` +
      "then run the script again.",
  )
  process.exit(1)
}

// Last, what git doesn't track at the old place (a .env, a symbolic link, build output), moved
// with the package, and its paths rewritten where it is text.
let carried: ReturnType<typeof carry>
try {
  carried = carry(root, olds, placeOf)
} catch (error) {
  console.error(
    `Carrying what git doesn't track stopped partway: ${error instanceof Error ? error.message : String(error)}\n` +
      "The move itself is done. Look at what is left at the old place, move it by hand, and run the script again.",
  )
  process.exit(1)
}
const carriedRewritten = carried.carried.filter(({ to }) => {
  if (!isText(to)) return false
  const text = read(to)
  const next = rewritePaths(text)
  if (next === text) return false
  writeFileSync(join(root, to), next)
  return true
})

// What the move leaves: mentions of the old UI in a form the rewrite doesn't read.
if (planned.writes.size > 0) git("add", "--", ...planned.writes.keys())
const left = tracked().flatMap((file) =>
  !isText(file) || keptFile(file)
    ? []
    : read(file)
        .split(/\r?\n/)
        .flatMap((line, index) =>
          leftover.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
        ),
)
const lockfile = git("status", "--porcelain", "--", "pnpm-lock.yaml").trim() !== ""
const changed = planned.moves.length + planned.removes.length + planned.writes.size > 0

console.log(
  !changed && carried.carried.length === 0
    ? lockfile
      ? "The install made pnpm-lock.yaml whole: commit it."
      : "Nothing to do: the tree is as the move leaves it."
    : `Moved ${planned.moves.length} files, deleted ${planned.removes.length} and wrote ${planned.writes.size} that the move changes.`,
)
if (carried.carried.length > 0)
  console.log(
    `Carried what git doesn't track to the new places${carriedRewritten.length > 0 ? `, rewriting ${carriedRewritten.length}` : ""}:\n${carried.carried.map(({ from, to }) => `${from} -> ${to}`).join("\n")}`,
  )
if (planned.skipped.length > 0)
  console.log(
    `Handwritten edits with nothing to do, for a person to check:\n${planned.skipped.join("\n")}`,
  )
if (carried.clashes.length > 0)
  console.error(
    `Left at an old place, as the new one holds another file: decide which stands.\n${carried.clashes.join("\n")}`,
  )
if (left.length > 0)
  console.error(`Mentions of the old UI the rewrite didn't reach:\n${left.join("\n")}`)
if (carried.clashes.length > 0 || left.length > 0) process.exit(1)
