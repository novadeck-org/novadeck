// What PR 1a of the UI split moves into `frontend/companion`: the table, and the exports that
// outsiders' imports need. package-move.ts does the rewriting; move-companion.ts runs it over
// the tree and its tests run it over text.

import { createMove, insertAfter, insertBefore, ui } from "./package-move.ts"
import * as toolkit from "./toolkit.ts"

export { insertAfter, insertBefore }

export const companionDir = "frontend/companion"
export const companionName = "@novadeck/companion"
const companionSrc = `${companionDir}/src`

const move = createMove({
  dir: companionDir,
  name: companionName,
  // The most specific first.
  rules: [
    { from: `${ui}/terminals/drag-session.ts`, to: `${companionSrc}/drag-session.ts` },
    { from: `${ui}/terminals/drag-session.test.ts`, to: `${companionSrc}/drag-session.test.ts` },
    { from: `${ui}/terminals/companion/`, to: `${companionSrc}/` },
  ],
  names: /terminals\/companion|drag-session/,
  // The toolkit moved first: an old branch's companion file still names `ui-toolkit/`.
  others: [toolkit],
})

export const { destinationOf, originOf, crossSpecifier, rewriteSpecifiers, exportKeyOf } = move

/**
 * The package's modules that `texts` import, as `@novadeck/companion/<module>` from outside it:
 * each key (`./<module>`) once. The package exports what is imported and no more, so these are
 * the exports a move needs.
 */
export const importedKeys = (texts: Iterable<string>): string[] => {
  const keys = new Set<string>()
  for (const text of texts)
    for (const [, key] of text.matchAll(/@novadeck\/companion\/([\w./-]+?)(?=["'?])/g))
      keys.add(`./${key}`)
  return [...keys].toSorted()
}

/** The imported keys the manifest has no export for. */
export const missingExports = (imported: readonly string[], exported: ReadonlySet<string>) =>
  imported
    .filter((key) => !exported.has(key))
    .map((key) => `${companionName} has no "${key}" export`)
