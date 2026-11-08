import type { ScreenText } from "@novadeck/emulator/headless"
import { cells } from "@novadeck/emulator/width"

import { hidesText, isEmpty, type BoxProfile, type InputBox } from "./box.js"

/**
 * What a program's input box holds as something more would go in, as the screen says. It says
 * nothing of whose words they are, or when to go on: the caller decides that.
 * - `none`: no box to type into: none on the screen, or a view, menu or dialog over it;
 * - `empty`: the box takes a prompt, and holds nothing;
 * - `shell`: the box is in its shell mode, where Enter runs what it holds;
 * - `command`: it holds what its program runs as a command (a leading `/` or `!`), which more
 *   text would only become the arguments of;
 * - `text`: it holds words, which what follows would go out with.
 * `tail` says the box may show only the end of what it holds (see `hidesText`).
 */
export type Leftover =
  | { readonly kind: "none" }
  | { readonly kind: "empty"; readonly box: InputBox }
  | { readonly kind: "shell" | "command" | "text"; readonly box: InputBox; readonly tail: boolean }

/** Whether a box's first row is a numbered menu's, as a menu's rows lead with the box's marker. */
export const menuRow = (text: string): boolean => /^\d+[.)]\s/.test(text.trimStart())

/** How a screen's box stands, as `Leftover` says. Fails closed: what it can't tell is `none`. */
export const leftoverOf = (profile: BoxProfile, screen: ScreenText): Leftover => {
  const box = profile.read(screen)
  if (!box || profile.overlay(screen)) return { kind: "none" }
  const tail = hidesText(profile, box, screen.rows.length)
  if (box.mode === "shell") return { kind: "shell", box, tail }
  if (isEmpty(box)) return { kind: "empty", box }
  if (menuRow(box.text)) return { kind: "none" }
  return { kind: /^\s*[/!]/.test(box.text) ? "command" : "text", box, tail }
}

/**
 * How far past a row's text its cursor may be, as spaces typed at its end show as nothing,
 * short of how far a menu that reads as a box parks it.
 */
const trailing = 16

/** The column a row's text ends at, as drawn undimmed: a faint suggestion is no part of it. */
const endOf = (screen: ScreenText, row: number): number =>
  cells((screen.bright[row] ?? "").trimEnd())

/**
 * Whether the cursor is at the end of what the box holds, where a paste lands after it, as it
 * lands at the cursor (probed 2026-11-06: in the middle of the text wherever the cursor was).
 * Far past the end, it's no cursor in a box at all: a menu that reads as one parks it there.
 */
export const cursorAtEnd = (profile: BoxProfile, box: InputBox, screen: ScreenText): boolean => {
  const { row, column } = screen.cursor
  if (row !== box.last) return false
  const end = endOf(screen, row)
  return column >= end - (profile.caret ?? 0) && column <= end + trailing
}

/**
 * The keys that take the cursor from where it is to the end of the box's text, once it is in
 * the box: Down to the last row, exactly so far, as Down past it recalls history, then End,
 * which alone stops at the end of its row. Probed on every harness (2026-11-06), on one line,
 * several, and a wrapped line. Undefined where the cursor is not in the box's text.
 */
export const toEnd = (box: InputBox, screen: ScreenText): string | undefined => {
  const { row, column } = screen.cursor
  if (row < box.first || row > box.last || column > endOf(screen, row) + trailing) return undefined
  return `${"\x1b[B".repeat(box.last - row)}\x1b[F`
}
