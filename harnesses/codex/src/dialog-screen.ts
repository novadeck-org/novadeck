import type { AnswerableDialog, KeyStep } from "@novadeck/harness-core/dialogs"
import { isFields, type Fields } from "@novadeck/harness-core/tools"
import type { RequestAnswer } from "@novadeck/protocol"

// What Codex's dialogs share: the screen's lines and numbered options, how a wording and a
// choice are read, and the composer under them.

export const squash = (text: string): string => text.replace(/\s+/g, "")

/** Whitespace runs as one space: what a terminal's wrapping and Codex's own spacing keep alike. */
export const collapse = (text: string): string => text.replace(/\s+/g, " ").trim()

/**
 * Whether `lines`, as the terminal wrapped them, read as `expected`: within a row every
 * character must match, whitespace included; between rows the break may stand for a space,
 * a newline or nothing at all (a long word broken inside). So `> x` is not `>x` and `a  b`
 * is not `a b`.
 */
export const wrapped = (lines: readonly string[], expected: string): boolean => {
  const want = expected.trim()
  let at = 0
  for (const line of lines) {
    const part = line.trim()
    if (part === "") continue
    while (at > 0 && at < want.length && /\s/.test(want[at]!)) at += 1
    if (!want.startsWith(part, at)) return false
    at += part.length
  }
  return at >= want.length
}

/** The screen's lines, without trailing space or blank lines. */
export const clean = (rows: readonly string[]): readonly string[] =>
  rows.map((row) => row.replace(/\s+$/, "")).filter((row) => row.length > 0)

const indent = (line: string): number => line.length - line.trimStart().length

// A numbered option: the highlight, its number, and what follows.
const optionLine = /^( {0,4})(›)? {0,3}(\d+)\. (\S.*)$/

export type Row = {
  readonly n: number
  readonly marked: boolean
  /** The option's first line, from its label on, columns of description and all. */
  readonly head: string
  /** All its lines, wrapped or not, joined by a space. */
  readonly text: string
}

/** The options numbered from 1 that start at `from`, and the line after them. */
export const optionsAt = (
  lines: readonly string[],
  from: number,
): { readonly rows: readonly Row[]; readonly next: number } => {
  const rows: Row[] = []
  let at = from
  for (;;) {
    const line = lines[at]
    const found = line === undefined ? null : optionLine.exec(line)
    if (!found || Number(found[3]) !== rows.length + 1) break
    const column = found[0].length - found[4]!.length
    const parts = [found[4]!]
    at += 1
    while (at < lines.length && !optionLine.test(lines[at]!) && indent(lines[at]!) >= column) {
      parts.push(lines[at]!.trim())
      at += 1
    }
    rows.push({
      n: rows.length + 1,
      marked: found[2] !== undefined,
      head: parts[0]!,
      text: parts.join(" "),
    })
  }
  return { rows, next: at }
}

/** The line of the first option in `lines` after `from`, or -1. */
export const firstOption = (lines: readonly string[], from: number): number => {
  for (let at = from; at < lines.length; at += 1) {
    const found = optionLine.exec(lines[at]!)
    if (found && found[3] === "1") return at
  }
  return -1
}

/** Whether `head` is `label`, alone or followed by its description's column. */
export const labelled = (head: string, label: string): boolean =>
  head === label || head.startsWith(`${label}  `)

export const fieldsOf = (value: unknown): Fields | undefined =>
  isFields(value) ? value : undefined

/**
 * What a dialog offers by its own wording: each label Codex has for it, and whether the
 * person's words go with it as a prompt after (the option that tells Codex what to do).
 */
export type Wording = { readonly label: RegExp; readonly prompt?: true }

export type Choice = {
  readonly id: string
  readonly label: string
  readonly key: string
  readonly text: "prompt" | null
}

/** What a read dialog is, before it becomes the driver's `DialogRead`. */
export type Parsed = {
  readonly dialog: AnswerableDialog
  readonly keys: (answer: RequestAnswer) => readonly KeyStep[] | undefined
  /** Its own test of an answer given, where the screen not showing it any more is not it. */
  readonly answered?: (rows: readonly string[]) => boolean
  readonly prompt?: (answer: RequestAnswer) => string | undefined
}

export const choose = (title: string, picks: readonly Choice[], detail: string | null): Parsed => ({
  dialog: {
    type: "choices",
    title,
    detail,
    options: picks.map(({ id, label, text }) => ({ id, label, text })),
  },
  keys: (answer) => {
    if (answer.type !== "choice") return undefined
    const pick = picks.find(({ id }) => id === answer.option)
    if (!pick || (answer.text !== undefined && pick.text === null)) return undefined
    return [{ press: pick.key }]
  },
})

/** Whether the composer's footer is drawn at the bottom: no dialog covers it. */
export const composerShown = (rows: readonly string[]): boolean =>
  clean(rows)
    .slice(-3)
    .some((line) => /\? for shortcuts|· (?:\/|~|[A-Za-z]:\\)/.test(line))
