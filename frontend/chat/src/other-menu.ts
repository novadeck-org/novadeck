import { harnesses } from "@novadeck/core/harnesses"

// Where a harness keeps skills under a key of their own, as Codex does under `$`, the key that is
// not the one typed, for the line over its menu. Each harness keeps its own keys, typed through
// untranslated, so this says where the rest are; null for a harness with one menu, or a menu of
// another kind (`@`, files). `$` opens at any word, `/` only at the start.
export const otherMenu = (agent: string | null, draft: string): string | null => {
  const words: readonly string[] = harnesses.find(({ id }) => id === agent)?.menus.words ?? []
  if (!words.includes("$")) return null
  if (draft.split(/\s/).at(-1)?.startsWith("$")) return "commands are under /"
  return draft.startsWith("/") ? "skills are under $" : null
}
