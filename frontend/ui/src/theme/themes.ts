import type { NoticeSound } from "@novadeck/core/sounds"

import type { Scheme } from "./scheme"

// The themes the app offers: an id, the name Preferences shows, the schemes it defines,
// the sound it rings with by default, and the file in `theme/` that draws it, `<id>.css` unless themes
// share one. The first theme is the default, used whenever a saved theme is unknown. See
// docs/theming.md.
export type ThemeEntry<Id extends string = string> = {
  readonly id: Id
  readonly name: string
  readonly schemes: readonly [Scheme, ...Scheme[]]
  // The notice sound the theme goes with, unless the person chose another: the id of
  // one of `noticeSounds` (see `sounds/`).
  readonly sound: NoticeSound
  readonly file?: string
  // The ids the theme went by before a rename: a preference or boot record saved under one
  // reads as this theme.
  readonly formerIds?: readonly string[]
}

export type ThemeManifest<Id extends string = string> = readonly [
  ThemeEntry<Id>,
  ...ThemeEntry<Id>[],
]

export const themes = [
  {
    id: "coolant",
    name: "Coolant",
    schemes: ["light", "dark"],
    sound: "felt",
    formerIds: ["graphite"],
  },
  {
    id: "phosphor-green",
    name: "Phosphor Green",
    schemes: ["dark"],
    sound: "afterglow",
    file: "phosphor",
  },
  {
    id: "phosphor-amber",
    name: "Phosphor Amber",
    schemes: ["dark"],
    sound: "afterglow",
    file: "phosphor",
  },
] as const satisfies ThemeManifest

export type ThemeId = (typeof themes)[number]["id"]

// The sound a saved theme id goes with: the shown theme's, so an id the app does not know
// goes with the default theme's.
export const soundOfTheme = (id: string): NoticeSound =>
  (themes.find((entry) => entry.id === id) ?? themes[0]).sound
