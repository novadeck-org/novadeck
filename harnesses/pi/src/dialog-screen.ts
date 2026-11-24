import { refuse } from "@novadeck/harness-core/dialogs"
import type { KeyStep } from "@novadeck/harness-core/dialogs"

/**
 * What pi's dialogs share (probed 2026-11-24, 1.6.0; fixtures/dialogs.probe.json): each takes the
 * input box's place, between full-width rules, its rows indented by one column, and ends with a
 * row of key hints. The title comes first (an extension's select, confirm, input or editor
 * title, its lines and blank lines as given, wrapped at the row's end), then what the dialog
 * takes: options, `→ ` before the selected one and three spaces before the others, a label too
 * long for its row going on in rows indented by one; a confirm's message under its title; an
 * input's field, `> ` and what was typed; an editor's own box between rules. A list longer
 * than ten shows ten and a count under them, `(1/14)`. The hardware cursor sits at a row's end
 * but in a field.
 */

export const enter = "\r"

export const squash = (text: string): string => text.replaceAll(/\s+/g, "")

/** How long each wait for the screen to follow a key lasts. */
export const timeoutMs = 3000

/** The hints of a select or a confirm, and of an input's and an editor's fields. */
export const selectHint = /^ ↑↓ navigate {2}enter select {2}escape\/ctrl\+c cancel\s*$/
export const inputHint = /^ enter submit {2}escape\/ctrl\+c cancel\s*$/
export const editorHint = /^ enter submit {2}shift\+enter\/ctrl\+j newline\b/

/** The screen's width, as its widest row (a rule spans it) shows it. */
export const widthOf = (rows: readonly string[]): number =>
  rows.reduce((widest, row) => Math.max(widest, row.trimEnd().length), 0)

/** Whether a row is a full-width rule of a dialog's or the box's frame. */
export const ruleRow = (row: string | undefined): boolean => /^─{8,}\s*$/.test(row ?? "")

/** The dialog whose hints `hint` matches once on the screen: its rows from its top rule to its hints. */
export type Block = {
  /** The rows between the dialog's top rule and its hints, trimmed at their ends. */
  readonly lines: readonly string[]
  /** Which screen row the first line is. */
  readonly first: number
}

/**
 * The block of the one dialog whose hint row `hint` matches: the rows from the rule over it down
 * to the hints. An editor's hints sit under its own box, whose rules are in the block, so the
 * frame's top rule is the one over the editor's (`nested`). Undefined with no such row, two, or
 * no rule over it.
 */
export const blockOf = (
  rows: readonly string[],
  hint: RegExp,
  nested = false,
): Block | undefined => {
  const at = rows.flatMap((row, index) => (hint.test(row) ? [index] : []))
  if (at.length !== 1) return refuse("screen.blockOf.1")
  const rules = rows.slice(0, at[0]).flatMap((row, index) => (ruleRow(row) ? [index] : []))
  const top = nested ? rules.at(-3) : rules.at(-1)
  if (top === undefined) return refuse("screen.blockOf.2")
  return {
    lines: rows.slice(top + 1, at[0]).map((row) => row.trimEnd()),
    first: top + 1,
  }
}

/** A row that starts an option: `→ ` selected, three spaces otherwise, at the dialog's indent. */
const optionStart = /^ (→| ) (\S.*)$/

/** A row that goes on with the label before it: indented by one, as the dialog's title is. */
const optionGoesOn = /^ (\S.*)$/

export type Options = {
  readonly labels: readonly string[]
  /** Which of them is selected. */
  readonly selected: number
  /** The line of the block the options start at. */
  readonly from: number
}

/**
 * The options at the end of a block: the run of rows after the last blank one, each started by
 * `→ ` or three spaces, a long label going on in rows indented by one (`width` the screen's
 * columns: a row its words fill reaches all but its last). Undefined where they don't
 * read so, where none or more than one is selected, or where the list shows only part of its
 * options, its count (`(1/14)`) under them.
 */
export const optionsOf = (lines: readonly string[], width: number): Options | undefined => {
  const end = lines.findLastIndex((line) => line.trim() !== "")
  if (end < 0) return refuse("screen.optionsOf.1")
  if (/^\s*\(\d+\/\d+\)$/.test(lines[end]!)) return refuse("screen.optionsOf.2")
  let from = end
  while (from > 0 && lines[from - 1]!.trim() !== "") from -= 1
  const labels: string[] = []
  let selected = -1
  let previous: string | undefined
  for (const line of lines.slice(from, end + 1)) {
    const before = previous
    previous = line
    const started = optionStart.exec(line)
    if (started) {
      if (started[1] === "→") {
        if (selected >= 0) return refuse("screen.optionsOf.3")
        selected = labels.length
      }
      labels.push(started[2]!)
      continue
    }
    const goesOn = optionGoesOn.exec(line)
    if (!goesOn || labels.length === 0) return refuse("screen.optionsOf.4")
    // A word longer than a row breaks at the row's end, with nothing between its parts.
    const full = (before ?? "").length >= width - 1
    labels[labels.length - 1] = `${labels.at(-1)}${full ? "" : " "}${goesOn[1]}`
  }
  if (selected < 0) return refuse("screen.optionsOf.5")
  return { labels, selected, from }
}

/** The keys that move the selection from `from` to `to`: Down or Up, one a row; the list doesn't wrap. */
export const moves = (from: number, to: number): string =>
  to >= from ? "\x1b[B".repeat(to - from) : "\x1b[A".repeat(from - to)

export const only = <T>(found: readonly T[]): T | undefined =>
  found.length === 1 ? found[0] : undefined

/** Words typed into a one-line field: no line breaks or other control characters. */
// eslint-disable-next-line no-control-regex -- These are the characters it refuses.
export const typeable = (text: string): boolean => /^[^\x00-\x1f\x7f]+$/.test(text)

/** Words for an editor: lines, but no other control character. */
// eslint-disable-next-line no-control-regex -- These are the characters it refuses.
export const writable = (text: string): boolean => /^[^\x00-\x09\x0b-\x1f\x7f]+$/.test(text)

/** How much of typed words must show where they were typed. */
const shownStart = 24

/** A wait until `text`'s start shows where `where` reads: the field it was typed into. */
export const shows = (
  text: string,
  where: (rows: readonly string[]) => string | undefined,
  why: string,
): KeyStep => {
  const start = squash(text).slice(0, shownStart)
  return {
    until: (rows) => start !== "" && squash(where(rows) ?? "").startsWith(start),
    timeoutMs,
    why,
  }
}

/** The title a request names, as an extension gave it; its lines and spaces don't count. */
export const titleOf = (input: unknown): string | undefined => {
  const { title } = (input ?? {}) as { title?: unknown }
  return typeof title === "string" && squash(title) !== "" ? title : refuse("dialog.titleOf.1")
}

/** A confirm's message, where the request names one. */
export const messageOf = (input: unknown): string | undefined => {
  const { message } = (input ?? {}) as { message?: unknown }
  return typeof message === "string" && squash(message) !== "" ? message : undefined
}
