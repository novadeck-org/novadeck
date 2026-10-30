import { noticeSoundOf, noticeSounds, type NoticeSound } from "@novadeck/core/sounds"
import type { PreferencesValue } from "@novadeck/core/types"

import { soundOfTheme } from "../theme/themes"

// The sounds Novadeck rings with. The list of them, ids and names, is the protocol's
// `noticeSounds`, shared with the desktop app; each id's file is `<id>.wav` in this folder.
// To add a sound, put its file here and a line in `noticeSounds` (see docs/theming.md).

// Always files, however small: the page's content policy refuses an inlined data: URL.
const files = import.meta.glob<string>("./*.wav", {
  query: "?no-inline",
  import: "default",
  eager: true,
})

// What Preferences offers: each sound with its name and the file the page plays.
export const sounds: readonly {
  readonly id: NoticeSound
  readonly name: string
  readonly url: string
}[] = noticeSounds.map(({ id, name }) => ({ id, name, url: files[`./${id}.wav`] ?? "" }))

export const soundUrl = (id: NoticeSound): string =>
  sounds.find((each) => each.id === id)?.url ?? ""

export const soundName = (id: NoticeSound): string =>
  noticeSounds.find((each) => each.id === id)?.name ?? id

// A saved sound choice made safe: "theme", or the id of a sound the app has. Anything else,
// such as a sound since removed, reads as "theme".
export const soundChoiceOf = (value: unknown): PreferencesValue["soundChoice"] =>
  noticeSoundOf(value) ?? "theme"

// The sound that rings: the person's choice, else the one the shown theme goes with.
export const soundInEffect = ({
  soundChoice,
  appearance,
}: Pick<PreferencesValue, "soundChoice" | "appearance">): NoticeSound =>
  noticeSoundOf(soundChoice) ?? soundOfTheme(appearance.theme)
