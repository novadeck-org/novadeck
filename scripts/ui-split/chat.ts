// What PR 3c of the UI split moves into `frontend/chat`: the table, and the exports that
// outsiders' imports need. package-move.ts does the rewriting; move-chat.ts runs it over the
// tree and its tests run it over text.

import * as companion from "./companion.ts"
import { createMove, insertAfter, insertBefore, ui } from "./package-move.ts"
import * as toolkit from "./toolkit.ts"

export { insertAfter, insertBefore }

export const chatDir = "frontend/chat"
export const chatName = "@novadeck/chat"
const chatSrc = `${chatDir}/src`

const move = createMove({
  dir: chatDir,
  name: chatName,
  rules: [{ from: `${ui}/terminals/chat/`, to: `${chatSrc}/` }],
  names: /terminals\/chat\//,
  // The toolkit and the companion moved first: an old branch's chat file still names
  // `ui-toolkit/` or `../companion/`.
  others: [toolkit, companion],
})

export const { destinationOf, originOf, crossSpecifier, rewriteSpecifiers, exportKeyOf } = move

/**
 * The package's modules that `texts` import, as `@novadeck/chat/<module>` from outside it:
 * each key (`./<module>`) once. The package exports what is imported and no more, so these are
 * the exports a move needs. (`@novadeck/chat-contract` has no slash after `chat`, so it isn't one.)
 */
export const importedKeys = (texts: Iterable<string>): string[] => {
  const keys = new Set<string>()
  for (const text of texts)
    for (const [, key] of text.matchAll(/@novadeck\/chat\/([\w./-]+?)(?=["'?])/g))
      keys.add(`./${key}`)
  return [...keys].toSorted()
}

/** The imported keys the manifest has no export for. */
export const missingExports = (imported: readonly string[], exported: ReadonlySet<string>) =>
  imported.filter((key) => !exported.has(key)).map((key) => `${chatName} has no "${key}" export`)
