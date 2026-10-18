import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import {
  destinationOf,
  edits,
  host,
  leftovers,
  pagesTest,
  rewritable,
  rewrite,
  svgTest,
} from "./desktop.ts"
import { applyEdit, carry, finish, ignoredPlaces, preflight, repository } from "./move.ts"

// `node scripts/packages/move-desktop.ts`: step 5's 5.3c. Moves the host into apps/desktop with
// the desktop app's page and the browser app's, which leave the UI for a build of the app's
// own, and points every mention of them at the new place. Like move-backend.ts it makes the
// tree so: run again, it does what is left, and on a tree with nothing to do it changes
// nothing. See scripts/packages/README.md.

const root = join(import.meta.dirname, "..", "..")
const { git, read, tracked } = repository(root)
const oxfmt = preflight(root, [host.from])

// The files the move writes whole, from the templates beside this script.
const templates = [
  "apps/desktop/vite.config.ts",
  "apps/desktop/vitest.config.ts",
  "apps/desktop/renderer/tsconfig.json",
  "apps/desktop/src/page.test.ts",
  "apps/desktop/src/packaging.test.ts",
].map((place) => ({
  place,
  text: readFileSync(join(import.meta.dirname, "desktop", `${place}.tmpl`), "utf8"),
}))

// The packages the pages bring to the app: the UI's, as the UI depends on them, and the build's.
const pageDependencies = [
  "@novadeck/build-kit",
  "@novadeck/core",
  "@novadeck/runner-adapter",
  "@novadeck/ui",
  "@tailwindcss/vite",
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "react",
  "react-dom",
  "tailwindcss",
]

// The plan, made whole before anything is written.
const files = tracked()
const present = new Set(files)
const problems: string[] = []
const moves = files.flatMap((file) => {
  const to = destinationOf(file)
  if (to === undefined) return []
  if (to !== null && present.has(to)) {
    problems.push(`${file} and ${to} are both tracked: keep one, at ${to}`)
    return []
  }
  return [{ from: file, to }]
})
const placeOf = new Map(moves.map(({ from, to }) => [from, to]))
const sourceOf = new Map(moves.flatMap(({ from, to }) => (to ? [[to, from] as const] : [])))
for (const place of ignoredPlaces(root, [
  ...moves.map(({ from }) => from),
  ...moves.flatMap(({ to }) => (to ? [to] : [])),
])) {
  const file = sourceOf.get(place) ?? place
  problems.push(
    `${file} is tracked, but its package ignores it as build output: git rm --cached ${file}`,
  )
}

// Every text at its place after the move, rewritten, edited and made whole.
const placed = new Map<string, string>()
for (const file of files) {
  const place = placeOf.has(file) ? placeOf.get(file) : file
  if (!place) continue
  placed.set(place, file)
}
const texts = new Map<string, string>()
const textOf = (place: string): string | undefined => {
  if (texts.has(place)) return texts.get(place)
  const file = placed.get(place)
  return file === undefined ? undefined : read(file)
}
for (const [place, file] of placed) {
  if (!rewritable(place)) continue
  const text = read(file)
  const next = rewrite(text)
  if (next !== text) texts.set(place, next)
}
const skipped: string[] = []
for (const edit of edits) {
  const text = textOf(edit.file)
  if (text === undefined) {
    skipped.push(`${edit.file} is gone: ${edit.why}`)
    continue
  }
  const made = applyEdit(text, edit)
  if ("problem" in made) problems.push(made.problem)
  else if (made.state === "made") texts.set(edit.file, made.text)
  else if (made.state === "gone") skipped.push(`${edit.file}, whose line changed: ${edit.why}`)
}
// The two tests of the pages that leave the UI, cut from its files: the desktop app has its own.
for (const { file, start, end } of [pagesTest, svgTest]) {
  const text = textOf(file)
  if (text === undefined || !text.includes(start)) continue
  const from = text.indexOf(start)
  const to = text.indexOf(end, from)
  if (to === -1)
    problems.push(
      `${file}: the test that starts ${JSON.stringify(start.trim())} doesn't end as expected`,
    )
  else texts.set(file, text.slice(0, from) + text.slice(to + end.length))
}
// The manifests: the app takes the pages' packages, and the UI lets go of the page's.
const json = (text: string) => JSON.parse(text) as Record<string, Record<string, string>>
const uiManifest = json(textOf("frontend/ui/package.json") ?? "{}")
const appText = textOf(`${host.to}/package.json`)
if (appText !== undefined) {
  const app = json(appText)
  const has = { ...app.dependencies, ...app.devDependencies }
  const versionOf = (name: string): string | undefined =>
    name.startsWith("@novadeck/")
      ? "workspace:*"
      : (uiManifest.dependencies?.[name] ?? uiManifest.devDependencies?.[name])
  const added = pageDependencies.filter((name) => !(name in has))
  for (const name of added) {
    const version = versionOf(name)
    if (version === undefined) problems.push(`no version for ${name}: the UI no longer names it`)
    else app.devDependencies = { ...app.devDependencies, [name]: version }
  }
  if (added.length > 0) {
    app.devDependencies = Object.fromEntries(
      Object.entries(app.devDependencies!).toSorted(([a], [b]) => a.localeCompare(b)),
    )
    texts.set(`${host.to}/package.json`, `${JSON.stringify(app, null, 2)}\n`)
  }
}
const uiText = textOf("frontend/ui/package.json")
if (uiText !== undefined) {
  const manifest = json(uiText)
  let changed = false
  if (manifest.dependencies?.["@novadeck/runner-adapter"]) {
    delete manifest.dependencies["@novadeck/runner-adapter"]
    changed = true
  }
  for (const script of ["dev", "build", "preview"])
    if (manifest.scripts?.[script]) {
      delete manifest.scripts[script]
      changed = true
    }
  if (changed) texts.set("frontend/ui/package.json", `${JSON.stringify(manifest, null, 2)}\n`)
}
for (const { place, text } of templates) if (textOf(place) !== text) texts.set(place, text)

if (problems.length > 0) {
  console.error(`Stopped, nothing changed. Decide these first:\n${problems.join("\n")}`)
  process.exit(1)
}

try {
  for (const { from, to } of moves) {
    if (to === null) {
      git("rm", "-q", from)
      continue
    }
    mkdirSync(join(root, dirname(to)), { recursive: true })
    git("mv", from, to)
  }
  for (const [place, text] of texts) {
    mkdirSync(join(root, dirname(place)), { recursive: true })
    writeFileSync(join(root, place), text)
  }
  git("add", "--", ...templates.map(({ place }) => place))
  finish(root, oxfmt, [...texts.keys()])
} catch (error) {
  console.error(
    `The move stopped partway: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n` +
      "The tree is half moved, and nothing git doesn't track has moved yet. Run " +
      "`git reset --hard && git clean -fd apps/desktop`, which keeps what git ignores there, " +
      "then run the script again.",
  )
  process.exit(1)
}

const carried = carry(root, [host.from], (file) =>
  file.startsWith(`${host.from}/`) ? `${host.to}${file.slice(host.from.length)}` : undefined,
)
for (const { to } of carried.carried)
  if (rewritable(to)) {
    const text = read(to)
    if (rewrite(text) !== text) writeFileSync(join(root, to), rewrite(text))
  }

const left = tracked().flatMap((file) => (rewritable(file) ? leftovers(file, read(file)) : []))
const lockfile = git("status", "--porcelain", "--", "pnpm-lock.yaml").trim() !== ""
console.log(
  moves.length === 0 && texts.size === 0 && carried.carried.length === 0 && !lockfile
    ? "Nothing to do: the tree is as the move leaves it."
    : `Moved ${moves.filter(({ to }) => to).length} files, removed ${moves.filter(({ to }) => !to).length} and wrote ${texts.size}.`,
)
if (lockfile && moves.length === 0) console.log("The install made pnpm-lock.yaml whole: commit it.")
if (carried.carried.length > 0)
  console.log(
    `Carried what git doesn't track to the new places:\n${carried.carried.map(({ from, to }) => `${from} -> ${to}`).join("\n")}`,
  )
if (skipped.length > 0)
  console.log(`Handwritten edits with nothing to do, for a person to check:\n${skipped.join("\n")}`)
if (carried.clashes.length > 0)
  console.error(
    `Left at an old place, as the new one holds another file: decide which stands.\n${carried.clashes.join("\n")}`,
  )
if (left.length > 0)
  console.error(`Mentions of a moved place the rewrite didn't reach:\n${left.join("\n")}`)
if (carried.clashes.length > 0 || left.length > 0) process.exit(1)
