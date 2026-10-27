/**
 * The sounds Novadeck rings with: an id, which names the file `<id>.wav` in the UI's
 * `sounds/`, and the name Preferences shows. Data only, so that the page, the core
 * and the desktop host share one list. A new sound is its file and a line here; a theme
 * names the one it rings with by its id (`sound` in `theme/themes.ts`).
 */
export const noticeSounds = [
  { id: "felt", name: "Felt" },
  { id: "afterglow", name: "Afterglow" },
  { id: "settle", name: "Settle" },
  { id: "beam", name: "Beam" },
] as const

/** The id of a sound in `noticeSounds`. */
export type NoticeSound = (typeof noticeSounds)[number]["id"]

/** The sound for anything that names none the app has: the default theme's. */
export const defaultNoticeSound: NoticeSound = "felt"

/** The sound a value names, or undefined for a value that is not the id of one. */
export const noticeSoundOf = (value: unknown): NoticeSound | undefined =>
  noticeSounds.find(({ id }) => id === value)?.id
