import type { ScreenText } from "@novadeck/emulator/headless"

import { compact, endsText } from "./text.js"

/**
 * What a program's input box holds, as a profile reads it off the screen. Only a profile
 * knows how its program draws the box; callers only ask what it holds.
 */
export type InputBox = {
  /**
   * What the box holds, one line per row, with its prompt marker and indent taken off;
   * empty for an empty box, whatever faint suggestion it shows.
   */
  readonly text: string
  /**
   * Whether the box is in its shell mode (`!`), where Enter runs what it holds as a
   * command, or takes a prompt: told by the marker leading its first row, and checked
   * against the program's footer, so a footer in shell mode over a prompt's marker reads
   * as no box at all.
   */
  readonly mode: "prompt" | "shell"
  /** The rows of the screen it spans, first to last. */
  readonly first: number
  readonly last: number
}

/** The markers leading a box's first row: in its prompt mode, and in its shell mode. */
export type Markers = { readonly prompt: string; readonly shell: string }

/** How a program draws its input box, as its profile knows it. */
export type BoxProfile = {
  /** How its input box reads off a screen; undefined where the screen shows none. */
  readonly read: (screen: ScreenText) => InputBox | undefined
  /**
   * Whether the box holds nothing but the placeholder the program shows for a long paste
   * (`[Pasted text #1 +39 lines]`), which stands for the pasted text.
   */
  readonly collapsed: (box: InputBox) => boolean
  /**
   * The keys that clear the text a box holds, for a program that puts text back in its box
   * (an interrupted prompt, messages queued behind a turn): written only over text seen
   * there, as a program's Escape twice may open a picker over an empty box. Omitted where
   * nothing comes back, and nothing is pressed. The screen it was read from comes too,
   * where the keys depend on what the program has taken of an earlier try: a first Escape
   * that says "Esc again to clear", and a pair of them written over that clears the box and
   * then opens a picker.
   */
  readonly clear?: (box: InputBox, screen?: ScreenText) => string
  /**
   * How the box takes a shell command (`!` typed in an empty box, then the command pasted):
   * `expands` where Enter runs a command it shows as a placeholder as the text the
   * placeholder stands for, false where it would run the placeholder's own text.
   */
  readonly shell: {
    readonly expands: boolean
    /**
     * Whether a command given to a program with no conversation yet starts one, as some
     * do; false where it runs without one, or the conversation exists before any command.
     */
    readonly starts: boolean
    /**
     * Whether the program's footer rows say the box is in its shell mode: the cross-check
     * of the marker, for the box reader and for tests that only have a screen's text.
     */
    readonly footer: (rows: readonly string[]) => boolean
    /**
     * The command to give the shell mode for `command` as written, where its shell runs
     * one otherwise than sh (cmd on Windows); as written where omitted, and
     * undefined for one that can't run there as written means.
     */
    readonly command?: (command: string, platform?: NodeJS.Platform) => string | undefined
  }
  /**
   * Whether the screen shows, just above the box, the program's word that whoever types
   * pressed Escape to stop the turn, where it may say so of a turn whose reply it kept;
   * omitted where something other than the screen tells.
   */
  readonly interrupted?: (screen: ScreenText) => boolean | undefined
  /**
   * Whether the screen shows a view, panel or search of the program beside or over its
   * conversation whose field or footer looks like its input box, so an empty box read off
   * it is not the program's own prompt: a line pasted there would go to the view, and its
   * Enter act in it.
   */
  readonly overlay: (screen: ScreenText) => boolean
  /**
   * Whether the screen shows messages queued behind the running turn, which the program
   * holds until the turn ends (or steers the turn with).
   */
  readonly queued: (screen: ScreenText) => boolean
  /**
   * Whether a paste of the text certainly shows as a placeholder, however small the
   * screen; false where it may show whole.
   */
  readonly collapses: (text: string) => boolean
  /**
   * How many rows the box may take on a screen of `rows` rows, with what the program
   * draws around it kept: a paste that shows whole and needs more has no first row to read.
   */
  readonly room: (rows: number) => number
  /**
   * How many rows the box shows of a text taller than that on a screen of `rows` rows: it
   * shows the text's tail, so a box that tall may hold only the end of what was put in it.
   * Omitted where the program's box shows all (or grows to `room`).
   */
  readonly viewport?: (rows: number) => number
  /**
   * The rows as the screen's calm reads them, without what the program redraws by itself
   * while idle at its prompt, as an elapsed time it counts up each second; omitted where it
   * redraws nothing so. Only what ticks while no turn runs: a running turn's spinner still
   * says the screen isn't calm.
   */
  readonly still?: (rows: readonly string[]) => readonly string[]
}

/** The fewest rows a profile's viewport can be and say a box is full by its height. */
const minViewport = 2

/**
 * Whether the box shows the tail of `text`, as a box shows a text taller than its viewport:
 * it is as tall as the viewport lets it be on a screen of `rows` rows, and what it shows ends
 * the text. A viewport of one row is every box's: on a screen too small to know it, none is.
 */
export const showsTail = (
  profile: BoxProfile,
  box: InputBox,
  rows: number,
  text: string,
): boolean => {
  const viewport = profile.viewport?.(rows) ?? Infinity
  return viewport >= minViewport && box.last - box.first + 1 >= viewport && endsText(box.text, text)
}

/** Whether the box holds nothing. */
export const isEmpty = (box: InputBox): boolean => compact(box.text) === ""

/**
 * The text of the rows `first` to `last`, whose first row starts with one of `markers`: the rows
 * as drawn undimmed, as a faint placeholder suggestion is not what was typed. Faint text is
 * still taken for content where the cursor is not right behind the marker, as a box with
 * text in it has it elsewhere. Undefined where the first row starts with neither marker.
 */
const read = (
  screen: ScreenText,
  first: number,
  last: number,
  markers: Markers,
): InputBox | undefined => {
  const rows = screen.rows.slice(first, last + 1)
  const mode = rows[0]?.startsWith(markers.prompt)
    ? "prompt"
    : rows[0]?.startsWith(markers.shell)
      ? "shell"
      : undefined
  if (mode === undefined) return undefined
  const marker = markers[mode]
  const lit = screen.bright.slice(first, last + 1)
  const lines = (shown: readonly string[]): string =>
    shown
      .map((row, index) =>
        (index === 0 ? row.slice(marker.length) : row).replace(/^[ \u00a0]{1,2}/, ""),
      )
      .join("\n")
      .trimEnd()
  const text = lines(lit)
  const faint = lines(rows)
  const home = screen.cursor.row === first && screen.cursor.column <= marker.length + 1
  // The cursor's cell over a placeholder's first letter is drawn undimmed (a hint such as
  // "Press up to edit queued messages" read as "P"): with the cursor at home and the rest
  // of the text faint, it is the placeholder, not a draft of one letter.
  const letter = compact(text).length === 1 && compact(faint).length > 1 && home
  if (compact(text) !== "" && !letter) return { text, mode, first, last }
  return { text: compact(faint) === "" || home ? "" : faint, mode, first, last }
}

/** Whether a row starts with a box's marker, in either mode. */
const leads = (row: string | undefined, markers: Markers): boolean =>
  row !== undefined && (row.startsWith(markers.prompt) || row.startsWith(markers.shell))

/**
 * The box, unless the program's footer says its shell mode (`shell`) over a box whose
 * marker says it takes a prompt: a screen half drawn, or one not known, reads as no box.
 * The other way round is no contradiction: the footer gives way to other hints (a
 * "paste again to expand" under a pasted command), while a marker of `!` is only
 * ever the shell mode's.
 */
export const agreeing = (box: InputBox | undefined, shell: boolean): InputBox | undefined =>
  box && !(shell && box.mode === "prompt") ? box : undefined

/**
 * The rows of a screen that show anything, from the one the cursor is on (in the box, or the
 * field of a view) down, and at least the last `count` of them: the box's footer and what a
 * view draws under it, where a profile says which view it is in (`BoxProfile.overlay`),
 * however many rows a status line takes; never the conversation above. A cursor far above
 * the foot (more than `reach` rows) is no anchor.
 */
export const footerRows = (screen: ScreenText, count = 4, reach = 12): readonly string[] => {
  const shown = screen.rows.map((row, at) => ({ row, at })).filter(({ row }) => row.trim() !== "")
  const below = shown.filter(({ at }) => at >= screen.cursor.row)
  const near = screen.rows.length - screen.cursor.row <= reach
  const last = shown.slice(-count)
  return (near && below.length > last.length ? below : last).map(({ row }) => row)
}

/** Whether a row is a horizontal rule. */
export const rule = (row: string | undefined): boolean => /^─{8,}$/.test((row ?? "").trim())

/**
 * A box drawn between two horizontal rules, its first row led by one of `markers` (`❯`, `>`): the
 * lowest pair of rules on the screen, the cursor between them.
 * It starts at the nearest row led by a marker at or above the cursor, so rows a TUI's
 * redraw left stale between the rules above its first row (it counts a wide character's
 * width differently, and erases the wrong rows) are no part of it. History above the
 * rules, a spinner, and the footer below do not matter.
 */
export const ruledBox = (screen: ScreenText, markers: Markers): InputBox | undefined => {
  const bottom = screen.rows.findLastIndex(rule)
  if (bottom < 0) return undefined
  const top = screen.rows.slice(0, bottom).findLastIndex(rule)
  if (top < 0 || bottom - top < 2) return undefined
  const { cursor } = screen
  if (cursor.row <= top || cursor.row >= bottom) return undefined
  for (let first = cursor.row; first > top; first -= 1)
    if (leads(screen.rows[first], markers)) return read(screen, first, bottom - 1, markers)
  return undefined
}

/**
 * A box drawn with no frame, its first row led by one of `markers` and its last the
 * cursor's row: rows indented under the marker go up from the cursor to it. The history
 * above is no part of it: it ends at the nearest row led by a marker.
 */
export const markedBox = (screen: ScreenText, markers: Markers): InputBox | undefined => {
  const { cursor } = screen
  let first = cursor.row
  for (; first >= 0; first -= 1) {
    const row = screen.rows[first] ?? ""
    if (leads(row, markers)) break
    // The body is indented under the marker, however much more the typed lines
    // are; a blank line may lie inside it, but the cursor's own row holds text, or the
    // cursor is elsewhere.
    const body = /^ {2}.*\S/.test(row) || (row.trim() === "" && first !== cursor.row)
    if (!body) return undefined
  }
  return first >= 0 ? read(screen, first, cursor.row, markers) : undefined
}
