import type { SelectOption } from "@novadeck/toolkit/Select"

import type { InstalledFonts } from "./local-fonts"

// The first entry of the terminal font's list: the font Novadeck ships, which a person with no
// choice made gets. Its value stands for "" in the saved preference.
export const builtInFont = "novadeck:built-in"

const family = (name: string, detail?: string): SelectOption => ({
  label: name,
  value: name,
  ...(detail && { description: detail }),
})

// The terminal font's list: the bundled font, then the monospaced families (they suit a
// terminal's grid), then the others, marked, since a proportional font in a grid looks uneven.
// A saved family the computer lists is the choice. One it doesn't is the bundled font, as the
// terminal draws it, unless the computer lists no fonts at all (a browser that can't, or a
// refused permission): the choice then stays what was saved, so it shows as it draws.
export const fontChoices = (
  installed: InstalledFonts,
  saved: string,
): { readonly items: readonly SelectOption[]; readonly value: string } => {
  const listed = new Set([...installed.monospace, ...installed.other])
  const kept = saved !== "" && listed.size === 0
  return {
    items: [
      { label: "JetBrains Mono", value: builtInFont, description: "Built in" },
      ...(kept ? [family(saved)] : []),
      ...installed.monospace.map((name) => family(name)),
      ...installed.other.map((name) => family(name, "Not monospace")),
    ],
    value: saved !== "" && (listed.has(saved) || kept) ? saved : builtInFont,
  }
}
