import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { applyEdit, type Edit } from "../packages/move.ts"
import { finish, isText, preflight, repository } from "../packages/move.ts"
import {
  destinationOf,
  insertAfter,
  insertBefore,
  rewriteSpecifiers,
  toolkitDir,
  toolkitName,
} from "./toolkit.ts"

// `node scripts/ui-split/move-toolkit.ts`: PR 0 of the UI split. Moves the UI's toolkit
// (`ui-toolkit/`, `class-name.ts` with its test, `sidebar/SidebarItem.tsx`) into
// `frontend/toolkit`, splits the sidebar item's base rules out of sidebar.css beside it, points
// every import that names a moved file at `@novadeck/toolkit/<module>`, and adds the toolkit to
// the UI's styles.css. It makes the tree so rather than doing a move: run again, it moves what
// a branch added at an old place and rewrites what it added that names one, and on a tree with
// nothing to do it changes nothing. The package's own files (manifest, configs, README, the
// one-line test.ts) and the checks that follow the move (architecture test, build guard, docs)
// are committed by hand, not written here.

const root = join(import.meta.dirname, "..", "..")
const { git, read, tracked } = repository(root)
const oxfmt = preflight(root, [])

const sidebarCss = "frontend/ui/src/sidebar/sidebar.css"
const itemCss = `${toolkitDir}/src/sidebar-item.css`
const styles = "frontend/ui/src/styles.css"

// The sidebar item's base rules: its look as a control, wherever it is drawn. What a context
// adds to it (tabs.css, team-wire.css) and the sidebar's own rules stay where they are.
const itemRules = `.sidebar-item:focus-within {
  --_bg: var(--item-hover-bg, var(--color-soft));
}
.sidebar-item.dragging {
  --_bg: var(--item-selected-bg, var(--color-paper));
  --_border-color: var(--item-selected-border-color, var(--color-line));
  --_shadow: var(--item-selected-shadow, var(--shadow-control));
}
.sidebar-item-select {
  border-radius: inherit;
  color: inherit;
}
.sidebar-item-select:focus-visible {
  outline-offset: -2px;
}
.sidebar-item-icon {
  color: var(--item-icon-fg, var(--color-muted));
}
`
const itemHeader = `/* The sidebar item's own looks (SidebarItem.tsx; the item recipe draws the rest): a row is a
   \`.sidebar-item\` holding a \`.sidebar-item-select\` button with a \`.sidebar-item-icon\`.
   Imported just before sidebar.css, whose rules it was part of, so the cascade holds. What a
   context adds to an item (the terminal tabs, the team wire) stays with that context.

   Hooks: the item recipe's, and the \`.dragging\` class while a row is dragged;
   \`:focus-within\` tints a row as hovering does.

   Tokens, each optional (its fallback in brackets): --item-hover-bg (soft), the
   --item-selected-* tokens (paper, line, the control shadow; also while dragged) and
   --item-icon-fg (muted). */
`

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

const current = (file: string): string => writes.get(file) ?? read(file)

// The importers, and the moved files themselves: every specifier that names a moved file.
for (const file of files) {
  if (!isText(file) || !/\.(?:[cm]?[jt]sx?|css)$/.test(file)) continue
  if (!file.startsWith("frontend/") && !file.startsWith("apps/") && !file.startsWith("tools/"))
    continue
  const text = read(file)
  const { text: next, problems: found } = rewriteSpecifiers(file, text, files)
  problems.push(...found)
  if (next !== text) writes.set(file, next)
}

// By-hand edits a rewrite can't make.
const edits: Edit[] = [
  {
    file: "frontend/ui/src/ui-toolkit/Popover.test.ts",
    before: `"src", "ui-toolkit", "icon-button.css"`,
    after: `"src", "icon-button.css"`,
    why: "the test reads the recipe beside it",
  },
]
for (const edit of edits) {
  const at = destinationOf(edit.file)
  const path = at && !files.has(edit.file) ? at : edit.file
  if (!files.has(path)) continue
  const done = applyEdit(current(path), edit)
  if ("problem" in done) problems.push(done.problem)
  else if (done.state === "made") writes.set(path, done.text)
}

// The item's base rules leave sidebar.css for the toolkit.
if (files.has(sidebarCss)) {
  const text = current(sidebarCss)
  if (text.includes(itemRules)) {
    writes.set(sidebarCss, text.replace(itemRules, ""))
    if (!files.has(itemCss)) writes.set(itemCss, itemHeader + itemRules)
  } else if (!files.has(itemCss) && !writes.has(itemCss)) {
    problems.push(
      `${sidebarCss} no longer holds the item's rules as the move knows them: split them into ${itemCss} by hand`,
    )
  }
}

// The UI's stylesheet: the toolkit scanned, and its item rules just before the sidebar's.
if (files.has(styles)) {
  let text = current(styles)
  const step = (next: string | undefined, why: string): void => {
    if (next === undefined) problems.push(`${styles}: ${why}`)
    else text = next
  }
  step(
    insertBefore(
      text,
      `@import "./sidebar/sidebar.css" layer(components);`,
      `@import "${toolkitName}/sidebar-item.css" layer(components);`,
    ),
    "no import of sidebar/sidebar.css to put the item's rules before",
  )
  step(
    insertAfter(text, `@source "../../demo-debug/src";`, `@source "../../toolkit/src";`),
    "no @source line of demo-debug to put the toolkit's after",
  )
  step(
    insertAfter(
      text,
      `@source not "../../demo-debug/src/**/*.test.ts";`,
      `@source not "../../toolkit/src/**/*.test.ts";`,
    ),
    "no @source not line of demo-debug to put the toolkit's after",
  )
  if (text !== read(styles) || writes.has(styles)) writes.set(styles, text)
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
  if (writes.size > 0 || moves.length > 0) finish(root, oxfmt, written)
  else finish(root, oxfmt, [])
  git("add", "--", ...new Set([...written, ...moves.map(({ to }) => to)]))
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
