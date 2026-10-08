import type { Scheme } from "./scheme"

// The themes the app offers: an id, the name Preferences shows, the schemes it defines,
// and the file in `theme/` that draws it, `<id>.css` unless themes share one. The first
// theme is the default, used whenever a saved theme is unknown. See docs/theming.md.
export type ThemeEntry<Id extends string = string> = {
  readonly id: Id
  readonly name: string
  readonly schemes: readonly [Scheme, ...Scheme[]]
  readonly file?: string
}

export type ThemeManifest<Id extends string = string> = readonly [
  ThemeEntry<Id>,
  ...ThemeEntry<Id>[],
]

export const themes = [
  { id: "graphite", name: "Graphite", schemes: ["light", "dark"] },
  { id: "phosphor-green", name: "Phosphor Green", schemes: ["dark"], file: "phosphor" },
  { id: "phosphor-amber", name: "Phosphor Amber", schemes: ["dark"], file: "phosphor" },
] as const satisfies ThemeManifest

export type ThemeId = (typeof themes)[number]["id"]
