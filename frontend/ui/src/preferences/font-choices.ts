import type { SelectOption } from "@novadeck/toolkit/Select"

import type { InstalledFonts } from "./local-fonts"

// The first entry of the terminal font's list: what a terminal draws when no family is chosen.
// Its value stands for "" in the saved preference.
export const builtInFont = "novadeck:built-in"

// The bundled font, which the standard themes draw terminals in (the CSS names it
// "JetBrains Mono Variable"); a person who installed JetBrains Mono has it twice otherwise.
const bundled = "JetBrains Mono"
export const isBundled = (family: string): boolean => /^JetBrains Mono( Variable)?$/i.test(family)

const family = (name: string, detail?: string): SelectOption => ({
  label: name,
  value: name,
  ...(detail && { description: detail }),
})

// The terminal font's list: the default entry, named for what the theme draws (the bundled font,
// "Built in", or the theme's own first family, "Theme"), then the monospaced families (they suit
// a terminal's grid), then the others, marked, since a proportional font in a grid looks uneven.
// A saved family the computer lists is the choice. One it doesn't is the default, as the terminal
// draws it, unless the computer lists no fonts at all (a browser that can't, or a refused
// permission): the choice then stays what was saved, so it shows as it draws. Under the bundled
// font's own entry, an installed "JetBrains Mono" is left out as a copy of it.
export const fontChoices = (
  installed: InstalledFonts,
  saved: string,
  themeFamily = bundled,
): { readonly items: readonly SelectOption[]; readonly value: string } => {
  const name = themeFamily || bundled
  const builtIn = isBundled(name)
  const listed = new Set([...installed.monospace, ...installed.other])
  const kept = saved !== "" && listed.size === 0
  const shown = (names: readonly string[]): readonly string[] =>
    builtIn ? names.filter((candidate) => candidate !== bundled) : names
  const monospace = shown(installed.monospace)
  const other = shown(installed.other)
  const offered = new Set([...monospace, ...other])
  return {
    items: [
      builtIn
        ? { label: bundled, value: builtInFont, description: "Built in" }
        : { label: name, value: builtInFont, description: "Theme" },
      ...(kept ? [family(saved)] : []),
      ...monospace.map((entry) => family(entry)),
      ...other.map((entry) => family(entry, "Not monospace")),
    ],
    value: saved !== "" && (offered.has(saved) || kept) ? saved : builtInFont,
  }
}
