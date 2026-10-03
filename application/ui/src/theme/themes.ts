// The themes the app offers: an id, the name Preferences shows, and the schemes its
// file in `themes/` defines. The first theme is the default, used whenever a saved
// theme is unknown. See docs/theming.md.

export type Scheme = "light" | "dark"
// What the person chose: a scheme, or whatever the system uses.
export type SchemePreference = "system" | Scheme

export type ThemeEntry<Id extends string = string> = {
  readonly id: Id
  readonly name: string
  readonly schemes: readonly [Scheme, ...Scheme[]]
}

export type ThemeManifest<Id extends string = string> = readonly [
  ThemeEntry<Id>,
  ...ThemeEntry<Id>[],
]

export const themes = [
  { id: "graphite", name: "Graphite", schemes: ["light", "dark"] },
  { id: "sandstone", name: "Sandstone", schemes: ["light"] },
] as const satisfies ThemeManifest

export type ThemeId = (typeof themes)[number]["id"]
