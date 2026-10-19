// What PR 0 of the UI split moves into `frontend/toolkit`, and how each import that names it is
// rewritten: package-move.ts does the rewriting, move-toolkit.ts runs it over the tree and its
// tests run it over text.

import { createMove, insertAfter, insertBefore, ui } from "./package-move.ts"

export { insertAfter, insertBefore }
export type { Rewritten } from "./package-move.ts"

export const toolkitDir = "frontend/toolkit"
export const toolkitName = "@novadeck/toolkit"
const toolkitSrc = `${toolkitDir}/src`

const move = createMove({
  dir: toolkitDir,
  name: toolkitName,
  // The most specific first.
  rules: [
    { from: `${ui}/class-name.ts`, to: `${toolkitSrc}/class-name.ts` },
    { from: `${ui}/class-name.test.ts`, to: `${toolkitSrc}/class-name.test.ts` },
    { from: `${ui}/sidebar/SidebarItem.tsx`, to: `${toolkitSrc}/SidebarItem.tsx` },
    { from: `${ui}/ui-toolkit/`, to: `${toolkitSrc}/` },
  ],
  names: /ui-toolkit|class-name|SidebarItem/,
})

export const { destinationOf, originOf, crossSpecifier, rewriteSpecifiers, exportKeyOf } = move

/** The exports the manifest lacks for `files` (toolkit files, at their new places). */
export const missingExports = (files: Iterable<string>, exported: ReadonlySet<string>): string[] =>
  [...new Set(files)].flatMap((file) => {
    const key = exportKeyOf(file)
    return key !== undefined && !exported.has(key) ? [`${file} has no "${key}" export`] : []
  })
